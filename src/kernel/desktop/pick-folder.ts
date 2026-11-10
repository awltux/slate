import { SlateError } from "../../domain/result.js";
import type { RunProbe } from "../catalog/probe.js";

/**
 * The native folder picker, run on the host that owns the files. A browser cannot give a page a folder *path* - the
 * platform deliberately hides it - so the only honest way to "pick a folder" for a server-side archive is to ask the
 * host's own desktop. It is a local command, like every other tool Slate runs.
 *
 * A host with no desktop (a server, a container, a remote session) has no dialog to show: that is a coded refusal, not
 * a hang, so the caller can fall back to a typed path or a browser save.
 */
export function pickFolderCommand(platform: NodeJS.Platform): string[] | null {
  switch (platform) {
    case "win32":
      // Windows PowerShell is STA, which the common dialog requires; `pwsh` is MTA and would throw.
      return [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        [
          "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
          "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
          "$d.Description = 'Choose a folder for the Slate archive'",
          "$d.ShowNewFolderButton = $true",
          "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath } else { exit 2 }",
        ].join("; "),
      ];
    case "darwin":
      return [
        "osascript",
        "-e",
        'POSIX path of (choose folder with prompt "Choose a folder for the Slate archive")',
      ];
    default:
      return ["zenity", "--file-selection", "--directory", "--title=Choose a folder for the Slate archive"];
  }
}

export interface PickedFolder {
  /** The absolute path the host chose. It never leaves the server: callers receive a token instead. */
  path: string;
}

/**
 * Open the picker and return what was chosen. `cancelled` is a refusal the caller can report as a decision, not an
 * error: closing a dialog is not a failure.
 */
export async function pickFolder(input: {
  run: RunProbe;
  platform?: NodeJS.Platform;
}): Promise<PickedFolder | "cancelled"> {
  const argv = pickFolderCommand(input.platform ?? process.platform);
  if (!argv) {
    throw new SlateError("capability_missing", "this platform has no folder dialog Slate knows how to open");
  }

  const result = await input.run(argv);
  if (result.failedToStart) {
    throw new SlateError(
      "capability_missing",
      "no folder dialog is available on this host; it needs a desktop session (or use a typed folder)",
      { detail: { binary: argv[0] } },
    );
  }
  // zenity and osascript both exit non-zero when the person closes the dialog without choosing.
  if (result.code === 2 || result.code === 1) return "cancelled";
  if (result.code !== 0) {
    throw new SlateError("service_unavailable", "the folder dialog failed", {
      retryable: true,
      detail: { code: result.code, stderr: result.stderr.slice(-400) },
    });
  }

  const path = result.stdout.trim().split(/\r?\n/u).filter(Boolean).pop() ?? "";
  if (path === "") return "cancelled";
  return { path };
}
