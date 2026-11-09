# Operation registry

Generated from `src/ops` by `pnpm docs:registry`. Do not edit by hand.

Every operation is reachable from the CLI (`slate op <name>`), from MCP (as the tool name below, which DSH
shows as `mcp__slate__<tool>`) and from the HTTP API (`POST /p/:projectId/api/op/<name>`).

| Operation | Policy | MCP tool | Summary |
|---|---|---|---|
| `blockout.attach` | write | `blockout_attach` | Attach a blockout for a shot: first and last stills, an optional animatic, and the camera. |
| `capabilities.get` | read | `capabilities_get` | Probe the host toolchain and report the chain that will run each stage, with the reason. |
| `cut.build` | write | `cut_build` | Build the cut from every shot that has a board or first frame, in scene order. |
| `cut.get` | read | `cut_get` | The current cut: its items, total duration and the last render. |
| `cut.render` | write | `cut_render` | Render the cut to MP4 through the assembly chain (FFmpeg concat for now). |
| `entity.create` | write | `entity_create` | Define a character, location or prop in the library. |
| `entity.list` | read | `entity_list` | The library: characters, locations and props with their current sheet. |
| `estimate.create` | read | `estimate_create` | Price a batch of takes for the given tier before anything is submitted. |
| `frame.attach` | write | `frame_attach` | Attach an image to a shot slot (board, first or last), copied into the project by content hash. |
| `graph.stale` | read | `graph_stale` | Nodes whose inputs changed since they were built, with the cause. |
| `history.revert` | destructive | `history_revert` | Undo the most recent commit by restoring the state before it. |
| `job.get` | read | `job_get` | The state of a job. |
| `plan.vocabulary` | read | `plan_vocabulary` | Valid values for shot and scene fields. |
| `previz.get` | read | `previz_get` | The sets and every shot's blockout state. |
| `project.create` | write | `project_create` | Create a project folder with its documents and genesis commit. |
| `project.history` | read | `project_history` | Recent commits: what changed, who changed it and why. |
| `project.rename` | write | `project_rename` | Change the project name. |
| `scene.create` | write | `scene_create` | Add a scene. Numbers are assigned in order and are never reused. |
| `scene.list` | read | `scene_list` | Scenes with their shots, readiness and staleness. |
| `scene.update` | write | `scene_update` | Change a scene. Its shots become stale because they were reviewed against the old text. |
| `service.clear-path` | write | `service_clear-path` | Forget an explicit executable path and go back to discovery. |
| `service.set-path` | write | `service_set-path` | Point a service at a specific executable, after checking that it runs. |
| `session.brief` | read | `session_brief` | A bounded read of where the film stands: the cheapest way for a new session to start. |
| `set.attach` | write | `set_attach` | Attach a digital set: a validated manifest, plus the .blend it came from when available. |
| `sheet.publish` | write | `sheet_publish` | Publish a new version of an entity's sheet from a set of view images. |
| `shot.create` | write | `shot_create` | Add a shot to a scene; it is built from that scene's current text. |
| `shot.get` | read | `shot_get` | One shot with its readiness checks and staleness. |
| `shot.rebase` | write | `shot_rebase` | Record that a shot has been re-checked against its scene's current text. |
| `shot.set-entities` | write | `shot_set-entities` | Set the entities in a shot and pin their current sheet versions. |
| `shot.update` | write | `shot_update` | Change a shot. Pass acceptScene to record that it was re-checked against the current scene. |
| `spend.approve` | spend | `spend_approve` | Approve an estimate and receive a single-use token that a generation job must present. |
| `spend.summary` | read | `spend_summary` | The budget, what is committed, and the most recent money movements. |
| `story.get` | read | `story_get` | The five-line story and its revisions. |
| `story.set` | write | `story_set` | Set the five lines and keep a revision of the previous version. |
| `take.generate` | spend | `take_generate` | Generate takes for an approved estimate. Requires the approval token from spend.approve. |
| `take.list` | read | `take_list` | Takes, optionally for one shot, with which one is selected. |
| `take.select` | write | `take_select` | Choose the take that represents a shot. |

## Input schemas

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
        "prop"
      ]
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "aliases": {
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
    "kind",
    "name"
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
        "prop"
      ]
    }
  },
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

### `project.rename`

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "expectedRevision": {
      "type": "integer"
    }
  },
  "required": [
    "name"
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

### `sheet.publish`

```json
{
  "type": "object",
  "properties": {
    "entityId": {
      "type": "string"
    },
    "views": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "role": {
            "type": "string",
            "enum": [
              "front",
              "three-quarter",
              "profile",
              "back",
              "close-up",
              "detail",
              "expression",
              "costume",
              "lighting"
            ]
          },
          "sourcePath": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "role",
          "sourcePath"
        ],
        "additionalProperties": false
      },
      "minItems": 1
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
    "entityId",
    "views"
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

