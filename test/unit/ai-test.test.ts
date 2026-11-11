import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope, FailureEnvelope } from "../../src/domain/result.js";
import type { HttpPort } from "../../src/kernel/ai/reference.js";
import { type OpContext, createRegistry } from "../../src/ops/index.js";
import { testContext } from "../helpers/context.js";

function expectOk<T>(result: Envelope<T> | FailureEnvelope): Envelope<T> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result;
}

let home: string;
let root: string;
let registry: ReturnType<typeof createRegistry>;
let context: OpContext;
let providerId: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "slate-ai-test-home-"));
  root = await mkdtemp(join(tmpdir(), "slate-ai-test-"));
  registry = createRegistry();
  context = testContext(root, { home });
  expectOk(await registry.execute("project.create", { root, name: "The Last Light" }, context));
  const provider = expectOk(
    await registry.execute(
      "ai.provider.save",
      { name: "fal", baseUrl: "https://fal.example", apiKey: "secret-key" },
      context,
    ),
  ).data as { id: string };
  providerId = provider.id;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** Answer every request with one status, and record what was asked. */
function answering(
  status: number,
  record?: Array<{ url: string; method: string; headers: Record<string, string> }>,
): HttpPort {
  return async (input) => {
    record?.push({ url: input.url, method: input.method, headers: input.headers ?? {} });
    return { status, body: JSON.stringify({ ok: status < 400 }) };
  };
}

describe("testing a provider", () => {
  it("proves the host answers, and says the key was accepted", async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const data = expectOk(
      await registry.execute(
        "ai.test",
        { providerId },
        testContext(root, { home, http: answering(200, seen) }),
      ),
    ).data as { reachable: boolean; status: number; auth: string; method: string };

    expect(data.reachable).toBe(true);
    expect(data.status).toBe(200);
    expect(data.auth).toBe("accepted");
    // A test is a reachability check: it never sends the endpoint's body.
    expect(data.method).toBe("GET");
    expect(seen[0]?.method).toBe("GET");
    // The key reaches the host in the provider's declared header.
    expect(seen[0]?.headers.Authorization).toBe("Bearer secret-key");
  });

  it("treats a refused key as a pass with the reason, not as a broken address", async () => {
    const data = expectOk(
      await registry.execute("ai.test", { providerId }, testContext(root, { home, http: answering(401) })),
    ).data as { reachable: boolean; auth: string; message: string };

    expect(data.reachable).toBe(true);
    expect(data.auth).toBe("refused");
    expect(data.message).toContain("key was refused");
  });

  it("reports an unreachable host as unreachable, with a code", async () => {
    const refusing: HttpPort = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await registry.execute(
      "ai.test",
      { providerId },
      testContext(root, { home, http: refusing }),
    );
    const data = expectOk(result).data as { reachable: boolean; status: number | null };
    expect(data.reachable).toBe(false);
    expect(data.status).toBeNull();
    // The failure is reported, not thrown: the interface shows the row, it does not crash.
    expect(result.ok).toBe(true);
  });

  it("tests one endpoint's path, and never the body it would generate with", async () => {
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId,
          name: "FLUX schnell",
          capability: "text-to-image",
          method: "POST",
          path: "/generate",
          resultPath: "images[0].url",
        },
        context,
      ),
    ).data as { id: string };

    const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const data = expectOk(
      await registry.execute(
        "ai.test",
        { endpointId: endpoint.id },
        testContext(root, { home, http: answering(200, seen) }),
      ),
    ).data as { target: string; url: string; method: string };

    expect(data.target).toBe("endpoint");
    expect(data.url).toBe("https://fal.example/generate");
    expect(data.method).toBe("GET");
  });

  it("refuses an endpoint that does not exist", async () => {
    const refused = await registry.execute("ai.test", { endpointId: "ep_nope" }, context);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("not_found");
  });
});

describe("what a failing test tells you", () => {
  it("reports the url, what was sent, the code and the response body", async () => {
    // A host that answers 500 with a body: the case a person actually needs to read.
    const failing: HttpPort = async () => ({
      status: 500,
      body: JSON.stringify({ error: { message: "model not activated" } }),
    });

    const data = expectOk(
      await registry.execute("ai.test", { providerId }, testContext(root, { home, http: failing })),
    ).data as {
      request: { method: string; url: string; headers: Record<string, string>; body: string };
      response: { status: number; body: string; error: string | null };
    };

    // The provider's test path defaults to "/", so the address it asks is the base url plus that path.
    expect(data.request.url).toBe("https://fal.example/");
    expect(data.request.method).toBe("GET");
    expect(data.request.body).toBe("");
    expect(data.response.status).toBe(500);
    expect(data.response.body).toContain("model not activated");
  });

  it("masks the key, so debug output is not a credential leak", async () => {
    let sentHeaders: Record<string, string> = {};
    const port: HttpPort = async (input) => {
      sentHeaders = input.headers ?? {};
      return { status: 200, body: "{}" };
    };

    const data = expectOk(
      await registry.execute("ai.test", { providerId }, testContext(root, { home, http: port })),
    ).data as { request: { headers: Record<string, string> } };

    // The real request carried the key...
    expect(sentHeaders.Authorization).toBe("Bearer secret-key");
    // ...and the report carries the scheme with the secret removed.
    expect(data.request.headers.Authorization).toBe("Bearer ***");
    expect(JSON.stringify(data)).not.toContain("secret-key");
  });

  it("reports the transport's own words when there was no answer", async () => {
    const refusing: HttpPort = async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:1");
    };
    const data = expectOk(
      await registry.execute("ai.test", { providerId }, testContext(root, { home, http: refusing })),
    ).data as { response: { status: null; body: string; error: string | null } };

    expect(data.response.status).toBeNull();
    expect(data.response.body).toBe("");
    // The reason is kept: "unreachable" alone tells you nothing about a proxy or a typo.
    expect(data.response.error).toContain("ECONNREFUSED");
  });
});

describe("the provider's test path", () => {
  it("is appended to the base url, so the path that proves a host can be declared", async () => {
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "openai-ish", baseUrl: "https://llm.example/v1", testPath: "/models", apiKey: "k" },
        context,
      ),
    ).data as { id: string };

    const data = expectOk(
      await registry.execute(
        "ai.test",
        { providerId: provider.id },
        testContext(root, { home, http: answering(200) }),
      ),
    ).data as { url: string; status: number };

    expect(data.url).toBe("https://llm.example/v1/models");
    expect(data.status).toBe(200);
  });

  it("does not add a second slash", async () => {
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "slashed", baseUrl: "https://llm.example/v1/", testPath: "models", apiKey: "k" },
        context,
      ),
    ).data as { id: string };

    const data = expectOk(
      await registry.execute(
        "ai.test",
        { providerId: provider.id },
        testContext(root, { home, http: answering(200) }),
      ),
    ).data as { url: string };
    expect(data.url).toBe("https://llm.example/v1/models");
  });

  it("is ignored when an endpoint is tested, because an endpoint has its own path", async () => {
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "host", baseUrl: "https://llm.example", testPath: "/models", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "image",
          capability: "text-to-image",
          method: "POST",
          path: "/generate",
        },
        context,
      ),
    ).data as { id: string };

    const data = expectOk(
      await registry.execute(
        "ai.test",
        { endpointId: endpoint.id },
        testContext(root, { home, http: answering(200) }),
      ),
    ).data as { url: string };
    expect(data.url).toBe("https://llm.example/generate");
  });
});

describe("sync and queue hosts", () => {
  it("records the call style, and defaults to sync", async () => {
    const sync = expectOk(
      await registry.execute("ai.provider.save", { name: "fal", baseUrl: "https://fal.run" }, context),
    ).data as { id: string };
    const catalog = expectOk(await registry.execute("ai.catalog", {}, context)).data as {
      providers: Array<{ id: string; mode: string }>;
    };
    expect(catalog.providers.find((entry) => entry.id === sync.id)?.mode).toBe("sync");
  });

  it("refuses to preview a queue host, because Slate cannot follow the request id", async () => {
    const queue = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "fal queue", baseUrl: "https://queue.fal.run", mode: "queue", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: queue.id,
          name: "Kling",
          capability: "video",
          method: "POST",
          path: "/fal-ai/kling-video/v1.6/standard/text-to-video",
        },
        context,
      ),
    ).data as { id: string };

    const refused = await registry.execute("ai.preview", { endpointId: endpoint.id }, context);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("capability_missing");
      expect(refused.error.message).toContain("queue");
    }
  });

  it("still lets a queue host be tested for reachability, and says that is all it proves", async () => {
    const queue = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "fal queue", baseUrl: "https://queue.fal.run", mode: "queue", apiKey: "k" },
        context,
      ),
    ).data as { id: string };

    const data = expectOk(
      await registry.execute(
        "ai.test",
        { providerId: queue.id },
        testContext(root, { home, http: answering(200) }),
      ),
    ).data as { mode: string; status: number; reachable: boolean };

    expect(data.mode).toBe("queue");
    expect(data.reachable).toBe(true);
    expect(data.status).toBe(200);
  });
});

describe("the method a test uses", () => {
  it("sends POST when the host only speaks POST, and says so", async () => {
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        {
          name: "fal",
          baseUrl: "https://fal.run",
          testPath: "/fal-ai/flux/schnell",
          testMethod: "POST",
          apiKey: "k",
        },
        context,
      ),
    ).data as { id: string };

    const seen: Array<{ method: string }> = [];
    const port: HttpPort = async (input) => {
      seen.push({ method: input.method });
      return { status: 422, body: JSON.stringify({ detail: [{ msg: "prompt is required" }] }) };
    };

    const data = expectOk(
      await registry.execute("ai.test", { providerId: provider.id }, testContext(root, { home, http: port })),
    ).data as {
      request: { method: string; body: string };
      response: { status: number; body: string };
      reachable: boolean;
    };

    expect(data.request.method).toBe("POST");
    // A test sends an empty object: enough to route and to check the key, not enough to describe a job.
    expect(data.request.body).toBe("{}");
    expect(seen[0]?.method).toBe("POST");
    expect(data.response.status).toBe(422);
    // 422 is a pass: the host answered and understood the address, it just wanted a prompt.
    expect(data.reachable).toBe(true);
    expect(data.response.body).toContain("prompt is required");
  });

  it("still defaults to GET, because a readable path is the simplest thing to prove", async () => {
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "llm", baseUrl: "https://llm.example", apiKey: "k" },
        context,
      ),
    ).data as { id: string };

    const data = expectOk(
      await registry.execute(
        "ai.test",
        { providerId: provider.id },
        testContext(root, { home, http: answering(200) }),
      ),
    ).data as { request: { method: string; body: string } };

    expect(data.request.method).toBe("GET");
    expect(data.request.body).toBe("");
  });
});

describe("testing an endpoint", () => {
  it("sends the endpoint's own body, rendered from its template", async () => {
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "fal", baseUrl: "https://fal.run", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "FLUX schnell",
          capability: "text-to-image",
          method: "POST",
          path: "/fal-ai/flux/schnell",
          body: { prompt: "{{prompt}}", image_size: "landscape_16_9", seed: "{{param:seed}}" },
          params: [{ key: "seed", type: "number", required: false, default: 7 }],
          resultPath: "images[0].url",
        },
        context,
      ),
    ).data as { id: string };

    let sent: string | undefined;
    const port: HttpPort = async (input) => {
      sent = typeof input.body === "string" ? input.body : undefined;
      return { status: 200, body: JSON.stringify({ images: [{ url: "https://fal.example/out.png" }] }) };
    };

    const data = expectOk(
      await registry.execute("ai.test", { endpointId: endpoint.id }, testContext(root, { home, http: port })),
    ).data as {
      request: { method: string; body: string };
      resultPathFound: boolean | null;
      chargesPossible: boolean;
      response: { status: number };
    };

    expect(data.request.method).toBe("POST");
    const body = JSON.parse(sent ?? "{}") as { prompt: string; image_size: string; seed: number };
    // The template's tokens are filled with sample values, and the parameter default is honoured.
    expect(body.prompt).toContain("lighthouse keeper");
    expect(body.image_size).toBe("landscape_16_9");
    expect(body.seed).toBe(7);
    expect(data.chargesPossible).toBe(true);
    expect(data.resultPathFound).toBe(true);
  });

  it("says when a 200 does not contain the result path it declares", async () => {
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "fal", baseUrl: "https://fal.run", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "odd model",
          capability: "text-to-image",
          method: "POST",
          path: "/odd",
          resultPath: "images[0].url",
        },
        context,
      ),
    ).data as { id: string };

    const port: HttpPort = async () => ({ status: 200, body: JSON.stringify({ output: "elsewhere" }) });
    const data = expectOk(
      await registry.execute("ai.test", { endpointId: endpoint.id }, testContext(root, { home, http: port })),
    ).data as { status: number; resultPathFound: boolean | null };

    expect(data.status).toBe(200);
    // A green 200 with the wrong shape is the failure this field exists to catch.
    expect(data.resultPathFound).toBe(false);
  });
});

describe("an endpoint test posts JSON", () => {
  it("sends a content-type with the body it renders", async () => {
    const provider = expectOk(
      await registry.execute(
        "ai.provider.save",
        { name: "fal", baseUrl: "https://fal.run", apiKey: "k" },
        context,
      ),
    ).data as { id: string };
    const endpoint = expectOk(
      await registry.execute(
        "ai.endpoint.save",
        {
          providerId: provider.id,
          name: "FLUX schnell",
          capability: "text-to-image",
          method: "POST",
          path: "/fal-ai/flux/schnell",
          body: { prompt: "{{prompt}}" },
          resultPath: "images[0].url",
        },
        context,
      ),
    ).data as { id: string };

    let sent: Record<string, string> = {};
    const port: HttpPort = async (request) => {
      sent = request.headers ?? {};
      // A host that cannot read the body as JSON answers 422 with the bytes it saw; that is the failure this guards.
      return sent["content-type"] === "application/json"
        ? { status: 200, body: JSON.stringify({ images: [{ url: "https://fal.example/out.png" }] }) }
        : {
            status: 422,
            body: JSON.stringify({ detail: [{ loc: ["body"], msg: "Input should be a valid dictionary" }] }),
          };
    };

    const data = expectOk(
      await registry.execute("ai.test", { endpointId: endpoint.id }, testContext(root, { home, http: port })),
    ).data as { status: number | null; resultPathFound: boolean | null };

    expect(sent["content-type"]).toBe("application/json");
    expect(data.status).toBe(200);
    expect(data.resultPathFound).toBe(true);
  });
});
