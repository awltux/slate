# Operation registry

Generated from `src/ops` by `pnpm docs:registry`. Do not edit by hand.

Every operation is reachable from the CLI (`slate op <name>`), from MCP (as the tool name below, which DSH
shows as `mcp__slate__<tool>`) and from the HTTP API (`POST /p/:projectId/api/op/<name>`).

| Operation | Policy | Scope | MCP tool | Summary |
|---|---|---|---|---|
| `agent.access` | read | host | `agent_access` | The surfaces an agent can drive, the command to wire one up, and how many operations it will see. |
| `ai.bindingset.remove` | destructive | project, owner | `ai_bindingset_remove` | Remove a binding set. |
| `ai.bindingset.save` | write | project, owner | `ai_bindingset_save` | Create or update a binding set: which endpoint serves each capability. |
| `ai.bindingset.use` | write | project, owner | `ai_bindingset_use` | Choose the binding set a project uses when it has not picked one itself. |
| `ai.bindingsets` | read | host | `ai_bindingsets` | The binding sets available to projects. |
| `ai.catalog` | read | project, owner | `ai_catalog` | AI providers, endpoints and capability bindings, with keys masked. |
| `ai.endpoint.draft` | read | project, owner | `ai_endpoint_draft` | Ask the bound text model to draft an endpoint declaration from the provider's base url and a path. |
| `ai.endpoint.save` | write | project, owner | `ai_endpoint_save` | Create or update an endpoint: one capability, one path, its parameters and request template. |
| `ai.preset.add` | write | host, owner | `ai_preset_add` | Add a known model and the provider it needs. |
| `ai.preview` | read | project, owner | `ai_preview` | Render the request an endpoint would send, without calling it. |
| `ai.provider.save` | write | project, owner | `ai_provider_save` | Create or update an AI provider: one host, one auth scheme, one credential. |
| `ai.reference.test` | read | project, owner | `ai_reference_test` | Upload a tiny test image through a provider's reference transport. |
| `ai.remove` | destructive | project, owner | `ai_remove` | Remove a provider or endpoint, its stored key, and any binding that pointed at it. |
| `ai.test` | read | host | `ai_test` | Check that a provider, or one of its endpoints, answers. |
| `blockout.attach` | write | project | `blockout_attach` | Attach a blockout for a shot: first and last stills, an optional animatic, and the camera. |
| `capabilities.get` | read | host | `capabilities_get` | Probe the host toolchain and report the chain that will run each stage, with the reason. |
| `cut.build` | write | project | `cut_build` | Build the cut from every shot that has a board or first frame, in scene order. |
| `cut.get` | read | project | `cut_get` | The current cut: its items, total duration and the last render. |
| `cut.render` | write | project | `cut_render` | Render the cut to MP4 at the project's shape and rate (FFmpeg concat for now). |
| `deliver.export` | spend | project | `deliver_export` | Encode the cut into a master with optional audio, run QC, and write a provenance manifest. |
| `deliver.qc` | read | project | `deliver_qc` | The QC report and manifest from the last delivery. |
| `dialog.pick-folder` | read | host, owner | `dialog_pick-folder` | Open the host's folder dialog and return a token naming the folder, not its path. |
| `entity.angles` | read | project | `entity_angles` | The views a sheet must cover: head rotations for a character, poses for a costume or a body. |
| `entity.create` | write | project | `entity_create` | Define a character, location, prop or style in the library. |
| `entity.delete` | destructive | project | `entity_delete` | Delete an entity that nothing references. |
| `entity.generate` | spend | project | `entity_generate` | Generate candidate images from an entity's prompt (or a variant's), through the bound image endpoint. |
| `entity.list` | read | project | `entity_list` | The library: entities with their sheets, variants and candidates. |
| `entity.update` | write | project | `entity_update` | Set an entity's description, its generation prompt, or the style sheet it uses. |
| `estimate.create` | read | project | `estimate_create` | Price a batch of takes for the given tier before anything is submitted. |
| `frame.attach` | write | project | `frame_attach` | Attach an image to a shot slot (board, first or last), copied into the project by content hash. |
| `frame.generate` | spend | project | `frame_generate` | Generate a shot's start or end frame from its scene's library items and the previz blockout. |
| `frame.select` | write | project | `frame_select` | Keep one of the generated images as the shot's start or end frame. |
| `graph.stale` | read | project | `graph_stale` | Nodes whose inputs changed since they were built, with the cause. |
| `history.revert` | destructive | project | `history_revert` | Undo the most recent commit by restoring the state before it. |
| `job.get` | read | project | `job_get` | The state of a job. |
| `library.import` | write | project | `library_import` | Copy a global library item into this project as a new entity. |
| `library.list` | read | project | `library_list` | The global library, plus which local entities are behind their global version. |
| `library.pull` | write | project | `library_pull` | Refresh a project entity from its global library item. |
| `library.push` | write | project | `library_push` | Publish a project entity to the global library, or bump its global version. |
| `library.styles` | read | host | `library_styles` | The style sheets available to a new project. |
| `note.add` | write | project | `note_add` | Leave a note on a shot, a scene, or the cut. |
| `note.list` | read | project | `note_list` | Notes, filtered by anchor or resolution. |
| `note.resolve` | write | project | `note_resolve` | Mark a note as handled. |
| `plan.vocabulary` | read | project | `plan_vocabulary` | Valid values for shot and scene fields. |
| `previz.get` | read | project | `previz_get` | The sets and every shot's blockout state. |
| `project.budget` | read | project | `project_budget` | The project's budget: its ceiling, what is committed, and what remains. |
| `project.create` | write | project | `project_create` | Create a project folder with its documents and genesis commit. |
| `project.delete` | destructive | project, owner | `project_delete` | Delete a project from this host, keeping its folder unless told otherwise. |
| `project.export` | read | project, owner | `project_export` | Write the project to a 7z archive with a manifest describing it. |
| `project.export-folder` | read | project | `project_export-folder` | The folder this project's archives are written to, as a label rather than a host path. |
| `project.history` | read | project | `project_history` | A page of commits: what changed, who changed it, why, and what was sent. |
| `project.import` | write | host, owner | `project_import` | Restore a project from a 7z archive written by project.export. |
| `project.set-export-folder` | write | project | `project_set-export-folder` | Choose, or reset, the folder this project's archives are written to. |
| `project.update` | write | project | `project_update` | Change the project's configuration: name, shape, rate, runtime, budget, model profile and look. |
| `prompt.expand` | spend | project | `prompt_expand` | Turn a description into a generation prompt, using the style sheet when one is applied. |
| `prompt.expand-text` | spend | project | `prompt_expand-text` | Turn a director's sentence into a generation prompt, using the film's look. |
| `review.link` | write | project | `review_link` | Create a signed, expiring link that lets a reviewer watch the cut and leave notes. |
| `review.links` | read | project | `review_links` | Review links with their expiry and revocation state. |
| `review.revoke` | destructive | project | `review_revoke` | Revoke a review link so it stops working immediately. |
| `scene.create` | write | project | `scene_create` | Add a scene. Numbers are assigned in order and are never reused. |
| `scene.list` | read | project | `scene_list` | Scenes with their shots, readiness and staleness. |
| `scene.set-entities` | write | project | `scene_set-entities` | Attach library items to a scene, or clear them. |
| `scene.update` | write | project | `scene_update` | Change a scene. Its shots become stale because they were reviewed against the old text. |
| `service.clear-path` | write | project | `service_clear-path` | Forget an explicit executable path and go back to discovery. |
| `service.set-path` | write | project | `service_set-path` | Point a service at a specific executable, after checking that it runs. |
| `session.brief` | read | project | `session_brief` | A bounded read of where the film stands: the cheapest way for a new session to start. |
| `set.attach` | write | project | `set_attach` | Attach a digital set: a validated manifest, plus the .blend it came from when available. |
| `sheet.edit` | write | project | `sheet_edit` | Open a sheet for editing, or replace the items in the sheet being edited. |
| `sheet.publish` | write | project | `sheet_publish` | Publish the sheet being edited and compose its active items into one reference image. |
| `shot.create` | write | project | `shot_create` | Add a shot to a scene; it is built from that scene's current text. |
| `shot.get` | read | project | `shot_get` | One shot with its readiness checks and staleness. |
| `shot.rebase` | write | project | `shot_rebase` | Record that a shot has been re-checked against its scene's current text. |
| `shot.set-entities` | write | project | `shot_set-entities` | Set the entities in a shot and pin their current identity sheets. |
| `shot.update` | write | project | `shot_update` | Change a shot. Pass acceptScene to record that it was re-checked against the current scene. |
| `spend.approve` | spend | project | `spend_approve` | Approve an estimate and receive a single-use token that a generation job must present. |
| `spend.summary` | read | project | `spend_summary` | The budget, what is committed, and the most recent money movements. |
| `story.get` | read | project | `story_get` | The five-line story and its revisions. |
| `story.set` | write | project | `story_set` | Set the five lines and keep a revision of the previous version. |
| `take.generate` | spend | project | `take_generate` | Generate takes for an approved estimate. Requires the approval token from spend.approve. |
| `take.list` | read | project | `take_list` | Takes, optionally for one shot, with which one is selected. |
| `take.select` | write | project | `take_select` | Choose the take that represents a shot. |
| `type.prompt.save` | write | project | `type_prompt_save` | Set, or clear, this project's copy of a library type's system prompt. |
| `type.prompt.save-global` | write | host, owner | `type_prompt_save-global` | Set, or clear, the host's copy of a library type's system prompt. |
| `type.prompts` | read | host | `type_prompts` | The system prompt for each library type, with which layer set it. |
| `variant.create` | write | project | `variant_create` | Add a wardrobe item or state variant, with its own description and prompt. |
| `variant.delete` | destructive | project | `variant_delete` | Delete a wardrobe item or state variant from an entity. |
| `variant.update` | write | project | `variant_update` | Change a wardrobe item's name, description or prompt. |

## Input schemas

### `agent.access`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `ai.bindingset.remove`

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `ai.bindingset.save`

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "description": {
      "type": "string",
      "default": ""
    },
    "bindings": {
      "type": "object",
      "additionalProperties": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "default": {}
    }
  },
  "required": [
    "name"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `ai.bindingset.use`

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `ai.bindingsets`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `ai.catalog`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `ai.endpoint.draft`

```json
{
  "type": "object",
  "properties": {
    "providerId": {
      "type": "string"
    },
    "path": {
      "type": "string",
      "minLength": 1
    },
    "hint": {
      "type": "string",
      "default": ""
    }
  },
  "required": [
    "providerId",
    "path"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `ai.endpoint.save`

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "providerId": {
      "type": "string"
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "capability": {
      "type": "string",
      "enum": [
        "text",
        "text-to-image",
        "video",
        "audio",
        "upscale",
        "upload",
        "image"
      ]
    },
    "method": {
      "type": "string",
      "enum": [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE"
      ],
      "default": "POST"
    },
    "path": {
      "type": "string",
      "default": "/"
    },
    "params": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "minLength": 1
          },
          "label": {
            "type": "string",
            "default": ""
          },
          "type": {
            "type": "string",
            "enum": [
              "string",
              "number",
              "integer",
              "boolean",
              "enum"
            ]
          },
          "required": {
            "type": "boolean",
            "default": false
          },
          "default": {
            "type": [
              "string",
              "number",
              "boolean"
            ]
          },
          "choices": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "default": []
          },
          "min": {
            "type": "number"
          },
          "max": {
            "type": "number"
          },
          "help": {
            "type": "string",
            "default": ""
          }
        },
        "required": [
          "key",
          "type"
        ],
        "additionalProperties": false
      },
      "default": []
    },
    "body": {
      "type": "object",
      "additionalProperties": {},
      "default": {}
    },
    "resultPath": {
      "type": "string",
      "default": ""
    },
    "response": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "minLength": 1
          },
          "type": {
            "type": "string",
            "enum": [
              "string",
              "number",
              "boolean",
              "string[]"
            ],
            "default": "string"
          },
          "description": {
            "type": "string",
            "default": ""
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "default": {}
    },
    "unitPriceUsd": {
      "type": "number",
      "minimum": 0,
      "default": 0
    },
    "imagesPerCall": {
      "type": "integer",
      "minimum": 1,
      "maximum": 4,
      "default": 1
    },
    "timeoutMs": {
      "type": "integer",
      "minimum": 1000,
      "maximum": 3600000,
      "default": 120000
    }
  },
  "required": [
    "providerId",
    "name",
    "capability"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `ai.preset.add`

```json
{
  "type": "object",
  "properties": {
    "presetId": {
      "type": "string"
    },
    "providerId": {
      "type": "string"
    },
    "baseUrl": {
      "type": "string",
      "format": "uri"
    }
  },
  "required": [
    "presetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `ai.preview`

```json
{
  "type": "object",
  "properties": {
    "endpointId": {
      "type": "string"
    },
    "capability": {
      "type": "string",
      "enum": [
        "text",
        "text-to-image",
        "video",
        "audio",
        "upscale",
        "upload",
        "image"
      ]
    },
    "reference": {
      "type": "object",
      "properties": {
        "assetId": {
          "type": "string"
        }
      },
      "required": [
        "assetId"
      ],
      "additionalProperties": false
    },
    "values": {
      "type": "object",
      "properties": {
        "prompt": {
          "type": "string",
          "default": "a lighthouse keeper at night"
        },
        "image": {
          "type": "string",
          "default": "https://example.invalid/reference.png"
        },
        "image2": {
          "type": "string",
          "default": "https://example.invalid/last.png"
        },
        "seconds": {
          "type": "number",
          "default": 5
        },
        "params": {
          "type": "object",
          "additionalProperties": {
            "type": [
              "string",
              "number",
              "boolean"
            ]
          },
          "default": {}
        }
      },
      "additionalProperties": false,
      "default": {
        "prompt": "a lighthouse keeper at night",
        "image": "https://example.invalid/reference.png",
        "image2": "https://example.invalid/last.png",
        "seconds": 5,
        "params": {}
      }
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `ai.provider.save`

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "kind": {
      "type": "string",
      "default": "custom"
    },
    "mode": {
      "type": "string",
      "enum": [
        "sync",
        "queue"
      ],
      "default": "sync"
    },
    "baseUrl": {
      "type": "string",
      "format": "uri"
    },
    "queue": {
      "type": "object",
      "properties": {
        "statusUrlPath": {
          "type": "string",
          "default": "status_url"
        },
        "responseUrlPath": {
          "type": "string",
          "default": "response_url"
        },
        "cancelUrlPath": {
          "type": "string",
          "default": "cancel_url"
        },
        "requestIdPath": {
          "type": "string",
          "default": "request_id"
        },
        "statusPath": {
          "type": "string",
          "default": "status"
        },
        "completeValue": {
          "type": "string",
          "default": "COMPLETED"
        },
        "failureValues": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": [
            "FAILED",
            "CANCELLED"
          ]
        },
        "pollMs": {
          "type": "integer",
          "minimum": 10,
          "maximum": 60000,
          "default": 1000
        },
        "maxPollMs": {
          "type": "integer",
          "minimum": 10,
          "maximum": 120000,
          "default": 8000
        }
      },
      "additionalProperties": false
    },
    "testPath": {
      "type": "string",
      "default": "/"
    },
    "testMethod": {
      "type": "string",
      "enum": [
        "GET",
        "POST"
      ],
      "default": "GET"
    },
    "authHeader": {
      "type": "string",
      "default": "Authorization"
    },
    "authScheme": {
      "type": "string",
      "default": "Bearer {{key}}"
    },
    "notes": {
      "type": "string",
      "default": ""
    },
    "apiKey": {
      "type": "string"
    },
    "reference": {
      "type": "object",
      "properties": {
        "transport": {
          "type": "string",
          "enum": [
            "inline",
            "upload"
          ],
          "default": "inline"
        },
        "maxInlineBytes": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "default": 1500000
        }
      },
      "additionalProperties": false
    }
  },
  "required": [
    "name",
    "baseUrl"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `ai.reference.test`

```json
{
  "type": "object",
  "properties": {
    "providerId": {
      "type": "string"
    }
  },
  "required": [
    "providerId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `ai.remove`

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": [
        "provider",
        "endpoint"
      ]
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "kind",
    "id"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `ai.test`

```json
{
  "type": "object",
  "properties": {
    "providerId": {
      "type": "string"
    },
    "endpointId": {
      "type": "string"
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `blockout.attach`

```json
{
  "type": "object",
  "properties": {
    "shotId": {
      "type": "string"
    },
    "setId": {
      "type": "string"
    },
    "firstFramePath": {
      "type": "string",
      "minLength": 1
    },
    "lastFramePath": {
      "type": "string",
      "minLength": 1
    },
    "animaticPath": {
      "type": "string",
      "minLength": 1
    },
    "camera": {
      "type": "object",
      "properties": {
        "lensMm": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "heightM": {
          "type": "number",
          "minimum": 0
        },
        "axisSide": {
          "type": [
            "number",
            "null"
          ]
        }
      },
      "required": [
        "lensMm",
        "heightM",
        "axisSide"
      ],
      "additionalProperties": false
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "shotId",
    "firstFramePath",
    "camera"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `capabilities.get`

```json
{
  "type": "object",
  "properties": {
    "refresh": {
      "type": "boolean",
      "default": false
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `cut.build`

```json
{
  "type": "object",
  "properties": {
    "expectedRevision": {
      "type": "integer"
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `cut.get`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `cut.render`

```json
{
  "type": "object",
  "properties": {
    "width": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 7680
    },
    "height": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 4320
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `deliver.export`

```json
{
  "type": "object",
  "properties": {
    "preset": {
      "type": "string",
      "enum": [
        "web",
        "master"
      ],
      "default": "web"
    },
    "audioPath": {
      "type": "string",
      "minLength": 1
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `deliver.qc`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `dialog.pick-folder`

```json
{}
```

### `entity.angles`

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": [
        "character",
        "location",
        "prop",
        "style",
        "costume",
        "body"
      ],
      "default": "character"
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `entity.create`

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": [
        "character",
        "location",
        "prop",
        "style",
        "costume",
        "body"
      ]
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "description": {
      "type": "string",
      "default": ""
    },
    "aliases": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "default": []
    },
    "forCharacter": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^ent\\_"
        },
        {
          "type": "null"
        }
      ],
      "default": null
    },
    "styleId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^ent\\_"
        },
        {
          "type": "null"
        }
      ],
      "default": null
    },
    "forBody": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^ent\\_"
        },
        {
          "type": "null"
        }
      ],
      "default": null
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "kind",
    "name"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `entity.delete`

```json
{
  "type": "object",
  "properties": {
    "entityId": {
      "type": "string"
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "entityId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `entity.generate`

```json
{
  "type": "object",
  "properties": {
    "entityId": {
      "type": "string"
    },
    "count": {
      "type": "integer",
      "minimum": 1,
      "maximum": 8,
      "default": 4
    },
    "variantId": {
      "type": [
        "string",
        "null"
      ],
      "default": null
    },
    "seed": {
      "type": "integer",
      "default": 0
    },
    "allowLocal": {
      "type": "boolean",
      "default": false
    }
  },
  "required": [
    "entityId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `entity.list`

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": [
        "character",
        "location",
        "prop",
        "style",
        "costume",
        "body"
      ]
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `entity.update`

```json
{
  "type": "object",
  "properties": {
    "entityId": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "prompt": {
      "type": "string"
    },
    "styleId": {
      "type": [
        "string",
        "null"
      ]
    },
    "forCharacter": {
      "type": [
        "string",
        "null"
      ]
    },
    "forBody": {
      "type": [
        "string",
        "null"
      ]
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "entityId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `estimate.create`

```json
{
  "type": "object",
  "properties": {
    "shotIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1
    },
    "tier": {
      "type": "string",
      "enum": [
        "draft",
        "final"
      ]
    }
  },
  "required": [
    "shotIds",
    "tier"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `frame.attach`

```json
{
  "type": "object",
  "properties": {
    "shotId": {
      "type": "string"
    },
    "role": {
      "type": "string",
      "enum": [
        "board",
        "first",
        "last"
      ]
    },
    "sourcePath": {
      "type": "string",
      "minLength": 1
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "shotId",
    "role",
    "sourcePath"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `frame.generate`

```json
{
  "type": "object",
  "properties": {
    "shotId": {
      "type": "string"
    },
    "role": {
      "type": "string",
      "enum": [
        "first",
        "last"
      ]
    },
    "prompt": {
      "type": "string",
      "default": ""
    },
    "entityIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "default": []
    },
    "useStartFrame": {
      "type": "boolean",
      "default": true
    },
    "count": {
      "type": "integer",
      "minimum": 1,
      "maximum": 4,
      "default": 1
    },
    "allowLocal": {
      "type": "boolean",
      "default": false
    },
    "useBlockout": {
      "type": "boolean",
      "default": true
    },
    "seed": {
      "type": "integer",
      "default": 0
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "shotId",
    "role"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `frame.select`

```json
{
  "type": "object",
  "properties": {
    "shotId": {
      "type": "string"
    },
    "role": {
      "type": "string",
      "enum": [
        "first",
        "last"
      ]
    },
    "assetId": {
      "type": "string"
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "shotId",
    "role",
    "assetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `graph.stale`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `history.revert`

```json
{
  "type": "object",
  "properties": {
    "commitId": {
      "type": "string"
    }
  },
  "required": [
    "commitId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `job.get`

```json
{
  "type": "object",
  "properties": {
    "jobId": {
      "type": "string"
    }
  },
  "required": [
    "jobId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `library.import`

```json
{
  "type": "object",
  "properties": {
    "libraryId": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "libraryId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `library.list`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `library.pull`

```json
{
  "type": "object",
  "properties": {
    "entityId": {
      "type": "string"
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "entityId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `library.push`

```json
{
  "type": "object",
  "properties": {
    "entityId": {
      "type": "string"
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "entityId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `library.styles`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `note.add`

```json
{
  "type": "object",
  "properties": {
    "anchor": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "shot",
            "scene",
            "cut"
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "kind",
        "id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "string",
      "minLength": 1
    },
    "author": {
      "type": "string"
    },
    "external": {
      "type": "boolean",
      "default": false
    }
  },
  "required": [
    "anchor",
    "body"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `note.list`

```json
{
  "type": "object",
  "properties": {
    "anchorKind": {
      "type": "string",
      "enum": [
        "shot",
        "scene",
        "cut"
      ]
    },
    "id": {
      "type": "string"
    },
    "includeResolved": {
      "type": "boolean",
      "default": true
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `note.resolve`

```json
{
  "type": "object",
  "properties": {
    "noteId": {
      "type": "string"
    }
  },
  "required": [
    "noteId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `plan.vocabulary`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `previz.get`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `project.budget`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `project.create`

```json
{
  "type": "object",
  "properties": {
    "root": {
      "type": "string",
      "minLength": 1
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "runtimeSeconds": {
      "type": "number",
      "exclusiveMinimum": 0,
      "default": 90
    },
    "aspectRatio": {
      "type": "string",
      "pattern": "^\\d+:\\d+$",
      "errorMessage": {
        "pattern": "aspect ratio must look like 16:9"
      },
      "default": "16:9"
    },
    "frameRate": {
      "type": "integer",
      "minimum": 1,
      "maximum": 120,
      "default": 24
    },
    "resolutionPixels": {
      "type": "integer",
      "minimum": 240,
      "maximum": 4320,
      "default": 1080
    },
    "budgetUsd": {
      "type": "number",
      "minimum": 0,
      "default": 0
    },
    "bindingSetId": {
      "type": [
        "string",
        "null"
      ],
      "default": null
    },
    "styleLibraryId": {
      "type": [
        "string",
        "null"
      ],
      "default": null
    }
  },
  "required": [
    "root",
    "name"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `project.delete`

```json
{
  "type": "object",
  "properties": {
    "confirmName": {
      "type": "string"
    },
    "keepAssets": {
      "type": "boolean",
      "default": true
    }
  },
  "required": [
    "confirmName"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `project.export`

```json
{
  "type": "object",
  "properties": {
    "destination": {
      "type": "string",
      "minLength": 1
    },
    "destinationId": {
      "type": "string",
      "minLength": 1
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `project.export-folder`

```json
{}
```

### `project.history`

```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "default": 20
    },
    "before": {
      "type": "string"
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `project.import`

```json
{
  "type": "object",
  "properties": {
    "archive": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "archive"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `project.set-export-folder`

```json
{}
```

### `project.update`

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "runtimeSeconds": {
      "type": "number",
      "minimum": 5,
      "maximum": 3600
    },
    "aspectRatio": {
      "type": "string",
      "pattern": "^\\d+:\\d+$",
      "errorMessage": {
        "pattern": "aspect ratio must look like 16:9"
      }
    },
    "frameRate": {
      "type": "integer",
      "minimum": 1,
      "maximum": 120
    },
    "resolutionPixels": {
      "type": "integer",
      "minimum": 240,
      "maximum": 4320
    },
    "budgetUsd": {
      "type": "number",
      "minimum": 0
    },
    "bindingSetId": {
      "type": [
        "string",
        "null"
      ]
    },
    "defaultStyleId": {
      "type": [
        "string",
        "null"
      ]
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `prompt.expand`

```json
{
  "type": "object",
  "properties": {
    "entityId": {
      "type": "string"
    },
    "variantId": {
      "type": [
        "string",
        "null"
      ],
      "default": null
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "entityId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `prompt.expand-text`

```json
{}
```

### `review.link`

```json
{
  "type": "object",
  "properties": {
    "label": {
      "type": "string",
      "default": ""
    },
    "expiresInHours": {
      "type": "integer",
      "minimum": 1,
      "maximum": 720,
      "default": 168
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `review.links`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `review.revoke`

```json
{
  "type": "object",
  "properties": {
    "linkId": {
      "type": "string"
    }
  },
  "required": [
    "linkId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `scene.create`

```json
{
  "type": "object",
  "properties": {
    "heading": {
      "type": "object",
      "properties": {
        "intExt": {
          "type": "string",
          "enum": [
            "INT",
            "EXT",
            "INT/EXT"
          ]
        },
        "location": {
          "type": "string",
          "minLength": 1
        },
        "timeOfDay": {
          "type": "string",
          "enum": [
            "DAY",
            "NIGHT",
            "DAWN",
            "DUSK",
            "MORNING",
            "EVENING",
            "CONTINUOUS"
          ]
        }
      },
      "required": [
        "intExt",
        "location",
        "timeOfDay"
      ],
      "additionalProperties": false
    },
    "synopsis": {
      "type": "string",
      "default": ""
    },
    "body": {
      "type": "string",
      "default": ""
    },
    "entityIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "default": []
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "heading"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `scene.list`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `scene.set-entities`

```json
{}
```

### `scene.update`

```json
{
  "type": "object",
  "properties": {
    "sceneId": {
      "type": "string"
    },
    "heading": {
      "type": "object",
      "properties": {
        "intExt": {
          "type": "string",
          "enum": [
            "INT",
            "EXT",
            "INT/EXT"
          ]
        },
        "location": {
          "type": "string",
          "minLength": 1
        },
        "timeOfDay": {
          "type": "string",
          "enum": [
            "DAY",
            "NIGHT",
            "DAWN",
            "DUSK",
            "MORNING",
            "EVENING",
            "CONTINUOUS"
          ]
        }
      },
      "required": [
        "intExt",
        "location",
        "timeOfDay"
      ],
      "additionalProperties": false
    },
    "synopsis": {
      "type": "string"
    },
    "body": {
      "type": "string"
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "sceneId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `service.clear-path`

```json
{}
```

### `service.set-path`

```json
{}
```

### `session.brief`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `set.attach`

```json
{
  "type": "object",
  "properties": {
    "manifest": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1
        },
        "units": {
          "type": "string",
          "enum": [
            "meters",
            "feet"
          ]
        },
        "fps": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "frameRange": {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": [
            {
              "type": "integer"
            },
            {
              "type": "integer"
            }
          ]
        },
        "entityMap": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          },
          "default": {}
        },
        "cameras": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "properties": {
              "lensMm": {
                "type": "number",
                "exclusiveMinimum": 0
              },
              "heightM": {
                "type": "number",
                "minimum": 0
              },
              "keys": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "frame": {
                      "type": "integer"
                    },
                    "position": {
                      "type": "array",
                      "minItems": 3,
                      "maxItems": 3,
                      "items": [
                        {
                          "type": "number"
                        },
                        {
                          "type": "number"
                        },
                        {
                          "type": "number"
                        }
                      ]
                    },
                    "rotation": {
                      "type": "array",
                      "minItems": 3,
                      "maxItems": 3,
                      "items": [
                        {
                          "type": "number"
                        },
                        {
                          "type": "number"
                        },
                        {
                          "type": "number"
                        }
                      ]
                    },
                    "lensMm": {
                      "type": "number",
                      "exclusiveMinimum": 0
                    }
                  },
                  "required": [
                    "frame",
                    "position",
                    "rotation",
                    "lensMm"
                  ],
                  "additionalProperties": false
                },
                "default": []
              }
            },
            "required": [
              "lensMm",
              "heightM"
            ],
            "additionalProperties": false
          },
          "default": {}
        }
      },
      "required": [
        "name",
        "units",
        "fps",
        "frameRange"
      ],
      "additionalProperties": false
    },
    "blendPath": {
      "type": "string",
      "minLength": 1
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "manifest"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `sheet.edit`

```json
{
  "type": "object",
  "properties": {
    "entityId": {
      "type": "string"
    },
    "variantId": {
      "type": [
        "string",
        "null"
      ],
      "default": null
    },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "assetId": {
            "type": "string"
          },
          "role": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "front",
                  "three-quarter-left",
                  "profile-left",
                  "back",
                  "profile-right",
                  "three-quarter-right",
                  "close-up",
                  "detail",
                  "lighting",
                  "plate",
                  "palette",
                  "texture",
                  "reference-sheet"
                ]
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "disabled",
              "deleted"
            ],
            "default": "active"
          }
        },
        "required": [
          "assetId"
        ],
        "additionalProperties": false
      }
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "entityId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `sheet.publish`

```json
{
  "type": "object",
  "properties": {
    "entityId": {
      "type": "string"
    },
    "variantId": {
      "type": [
        "string",
        "null"
      ],
      "default": null
    },
    "heightM": {
      "type": "number",
      "exclusiveMinimum": 0
    },
    "rights": {
      "type": "object",
      "properties": {
        "licence": {
          "type": "string"
        },
        "likenessConsent": {
          "type": "string",
          "enum": [
            "granted",
            "not-required",
            "pending",
            "expired"
          ]
        }
      },
      "additionalProperties": false
    },
    "note": {
      "type": "string",
      "default": ""
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "entityId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `shot.create`

```json
{
  "type": "object",
  "properties": {
    "sceneId": {
      "type": "string"
    },
    "number": {
      "type": "string",
      "minLength": 1
    },
    "size": {
      "type": "string",
      "enum": [
        "EWS",
        "WS",
        "MWS",
        "MS",
        "MCU",
        "CU",
        "ECU",
        "INSERT",
        "TWO-SHOT",
        "OTS"
      ]
    },
    "angle": {
      "type": "string",
      "enum": [
        "EYE",
        "LOW",
        "HIGH",
        "DUTCH",
        "BIRDSEYE",
        "OVERHEAD"
      ]
    },
    "movement": {
      "type": "string",
      "enum": [
        "STATIC",
        "PAN",
        "TILT",
        "PUSH",
        "PULL",
        "TRACK",
        "HANDHELD",
        "CRANE",
        "ZOOM"
      ]
    },
    "durationSec": {
      "type": "number",
      "exclusiveMinimum": 0,
      "maximum": 120
    },
    "description": {
      "type": "string",
      "default": ""
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "sceneId",
    "size",
    "angle",
    "movement",
    "durationSec"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `shot.get`

```json
{
  "type": "object",
  "properties": {
    "shotId": {
      "type": "string"
    }
  },
  "required": [
    "shotId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `shot.rebase`

```json
{
  "type": "object",
  "properties": {
    "shotId": {
      "type": "string"
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "shotId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `shot.set-entities`

```json
{}
```

### `shot.update`

```json
{
  "type": "object",
  "properties": {
    "shotId": {
      "type": "string"
    },
    "number": {
      "type": "string",
      "minLength": 1
    },
    "size": {
      "type": "string",
      "enum": [
        "EWS",
        "WS",
        "MWS",
        "MS",
        "MCU",
        "CU",
        "ECU",
        "INSERT",
        "TWO-SHOT",
        "OTS"
      ]
    },
    "angle": {
      "type": "string",
      "enum": [
        "EYE",
        "LOW",
        "HIGH",
        "DUTCH",
        "BIRDSEYE",
        "OVERHEAD"
      ]
    },
    "movement": {
      "type": "string",
      "enum": [
        "STATIC",
        "PAN",
        "TILT",
        "PUSH",
        "PULL",
        "TRACK",
        "HANDHELD",
        "CRANE",
        "ZOOM"
      ]
    },
    "durationSec": {
      "type": "number",
      "exclusiveMinimum": 0,
      "maximum": 120
    },
    "description": {
      "type": "string"
    },
    "acceptScene": {
      "type": "boolean",
      "default": false
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "shotId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `spend.approve`

```json
{
  "type": "object",
  "properties": {
    "estimateId": {
      "type": "string"
    }
  },
  "required": [
    "estimateId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `spend.summary`

```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "default": 10
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `story.get`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `story.set`

```json
{
  "type": "object",
  "properties": {
    "lines": {
      "type": "object",
      "properties": {
        "situation": {
          "type": "string"
        },
        "desire": {
          "type": "string"
        },
        "conflict": {
          "type": "string"
        },
        "change": {
          "type": "string"
        },
        "result": {
          "type": "string"
        }
      },
      "required": [
        "situation",
        "desire",
        "conflict",
        "change",
        "result"
      ],
      "additionalProperties": false
    },
    "note": {
      "type": "string",
      "default": ""
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "lines"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `take.generate`

```json
{
  "type": "object",
  "properties": {
    "token": {
      "type": "string",
      "minLength": 1
    },
    "seed": {
      "type": "integer",
      "default": 0
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "token"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `take.list`

```json
{
  "type": "object",
  "properties": {
    "shotId": {
      "type": "string"
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `take.select`

```json
{
  "type": "object",
  "properties": {
    "takeId": {
      "type": "string"
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "takeId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `type.prompt.save`

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string"
    },
    "prompt": {
      "type": "string"
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "kind",
    "prompt"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `type.prompt.save-global`

```json
{}
```

### `type.prompts`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `variant.create`

```json
{
  "type": "object",
  "properties": {
    "entityId": {
      "type": "string"
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "description": {
      "type": "string",
      "default": ""
    },
    "prompt": {
      "type": "string",
      "default": ""
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "entityId",
    "name"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `variant.delete`

```json
{
  "type": "object",
  "properties": {
    "entityId": {
      "type": "string"
    },
    "variantId": {
      "type": "string"
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "entityId",
    "variantId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `variant.update`

```json
{
  "type": "object",
  "properties": {
    "entityId": {
      "type": "string"
    },
    "variantId": {
      "type": "string"
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "description": {
      "type": "string"
    },
    "prompt": {
      "type": "string"
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "entityId",
    "variantId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

