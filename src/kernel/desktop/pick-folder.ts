import { homedir } from "node:os";
import { join } from "node:path";
import { SlateError } from "../../domain/result.js";
import type { RunProbe } from "../catalog/probe.js";
import { slugify } from "../workspace/projects.js";

/**
 * The native folder picker, run on the host that owns the files. A browser cannot give a page a folder *path* - the
 * platform deliberately hides it - so the only honest way to "pick a folder" for a server-side archive is to ask the
 * host's own desktop. It is a local command, like every other tool Slate runs.
 *
 * The dialog needs an owner window marked topmost: started from a server process it has no taskbar button and no
 * foreground right, so it appears behind the browser and looks like nothing happened.
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
          // A topmost owner puts the dialog in front of the browser and gives it a foreground window to belong to.
          "$owner = New-Object System.Windows.Forms.Form",
          "$owner.TopMost = $true",
          "$owner.ShowInTaskbar = $false",
          "$owner.WindowState = 'Minimized'",
          "$owner.Show()",
          "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
          "$d.Description = 'Choose a folder for the Slate archive'",
          "$d.ShowNewFolderButton = $true",
          "$r = $d.ShowDialog($owner)",
          "$owner.Close()",
          "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath } else { exit 2 }",
        ].join("; "),
      ];
    case "darwin":
      return [
        "osascript",
        "-e",
        'tell application "System Events" to activate',
        "-e",
        'POSIX path of (choose folder with prompt "Choose a folder for the Slate archive")',
      ];
    default:
      return ["zenity", "--file-selection", "--directory", "--title=Choose a folder for the Slate archive"];
  }
}

/** Closing a dialog is exit 2 on Windows and 1 on the others; anything else is a real failure. */
function isCancelled(platform: NodeJS.Platform, code: number | null): boolean {
  return platform === "win32" ? code === 2 : code === 1;
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
  const platform = input.platform ?? process.platform;
  const argv = pickFolderCommand(platform);
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
  if (isCancelled(platform, result.code)) return "cancelled";
  if (result.code === null) {
    throw new SlateError(
      "service_unavailable",
      "the folder dialog did not answer within the time limit: it may have opened behind this window",
      { retryable: true },
    );
  }
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

/**
 * Where a project's archives go when nobody chose a folder: the OS downloads folder, under a Slate tree named after the
 * film. It is a convention, not a stored path - so a project document never carries one, and the folder is created the
 * first time it is used.
 */
export function defaultExportFolder(input: {
  projectName: string;
  downloadsDir?: string;
}): { path: string; label: string } {
  // SLATE_DOWNLOADS_DIR relocates the downloads folder for a host that keeps it elsewhere, and lets tests stay out of
  // the real one.
  const downloads = input.downloadsDir ?? process.env.SLATE_DOWNLOADS_DIR ?? join(homedir(), "Downloads");
  const slug = slugify(input.projectName);
  return { path: join(downloads, "slate", "exports", slug), label: `Downloads/slate/exports/${slug}` };
}
