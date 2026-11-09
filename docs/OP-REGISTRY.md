# Operation registry

Generated from `src/ops` by `pnpm docs:registry`. Do not edit by hand.

Every operation is reachable from the CLI (`slate op <name>`), from MCP (as the tool name below, which DSH
shows as `mcp__slate__<tool>`) and from the HTTP API (`POST /p/:projectId/api/op/<name>`).

| Operation | Policy | MCP tool | Summary |
|---|---|---|---|
| `capabilities.get` | read | `capabilities_get` | Probe the host toolchain and report the chain that will run each stage, with the reason. |
| `cut.build` | write | `cut_build` | Build the cut from every shot that has a board or first frame, in scene order. |
| `cut.get` | read | `cut_get` | The current cut: its items, total duration and the last render. |
| `cut.render` | write | `cut_render` | Render the cut to MP4 through the assembly chain (FFmpeg concat for now). |
| `frame.attach` | write | `frame_attach` | Attach an image to a shot slot (board, first or last), copied into the project by content hash. |
| `graph.stale` | read | `graph_stale` | Nodes whose inputs changed since they were built, with the cause. |
| `plan.vocabulary` | read | `plan_vocabulary` | Valid values for shot and scene fields. |
| `project.create` | write | `project_create` | Create a project folder with its documents and genesis commit. |
| `project.history` | read | `project_history` | Recent commits: what changed, who changed it and why. |
| `scene.create` | write | `scene_create` | Add a scene. Numbers are assigned in order and are never reused. |
| `scene.list` | read | `scene_list` | Scenes with their shots, readiness and staleness. |
| `scene.update` | write | `scene_update` | Change a scene. Its shots become stale because they were reviewed against the old text. |
| `service.clear-path` | write | `service_clear-path` | Forget an explicit executable path and go back to discovery. |
| `service.set-path` | write | `service_set-path` | Point a service at a specific executable, after checking that it runs. |
| `session.brief` | read | `session_brief` | A bounded read of where the film stands: the cheapest way for a new session to start. |
| `shot.create` | write | `shot_create` | Add a shot to a scene; it is built from that scene's current text. |
| `shot.get` | read | `shot_get` | One shot with its readiness checks and staleness. |
| `shot.rebase` | write | `shot_rebase` | Record that a shot has been re-checked against its scene's current text. |
| `shot.update` | write | `shot_update` | Change a shot. Pass acceptScene to record that it was re-checked against the current scene. |
| `story.get` | read | `story_get` | The five-line story and its revisions. |
| `story.set` | write | `story_set` | Set the five lines and keep a revision of the previous version. |

## Input schemas

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
      "maximum": 7680,
      "default": 1280
    },
    "height": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 4320,
      "default": 720
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
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

### `graph.stale`

```json
{
  "type": "object",
  "properties": {},
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
    "budgetUsd": {
      "type": "number",
      "minimum": 0,
      "default": 0
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

### `project.history`

```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200,
      "default": 20
    }
  },
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

