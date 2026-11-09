import { describe, expect, it } from "vitest";
import { parseUninstallRegistry } from "../../src/kernel/catalog/registry-scan.js";

/**
 * A recorded slice of `reg query HKLM\...\Uninstall /s`, including the two things that break naive parsing:
 * keys with no install location, and padding of varying width.
 */
const FIXTURE = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{A1}

    DisplayName    REG_SZ    Blender
    DisplayVersion    REG_SZ    5.2.2
    InstallLocation    REG_SZ    E:\\Blender\\Blender 5.2\\

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{B2}

    DisplayName    REG_SZ    OpenShot Video Editor 4.1.1
    DisplayVersion    REG_SZ    4.1.1
    InstallLocation    REG_SZ    E:\\OpenShotVideoEditor\\

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{C3}

    DisplayName    REG_SZ    Something Without A Location
    DisplayVersion    REG_SZ    1.0.0

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{D4}

    DisplayName    REG_SZ    Blender
    DisplayVersion    REG_SZ    4.4.3
    InstallLocation    REG_SZ    C:\\Program Files\\Blender Foundation\\Blender 4.4\\
`;

describe("parseUninstallRegistry", () => {
  it("extracts the display name, version and install location per entry", () => {
    const entries = parseUninstallRegistry(FIXTURE);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({
      displayName: "Blender",
      version: "5.2.2",
      location: "E:\\Blender\\Blender 5.2\\",
    });
    expect(entries[1]?.displayName).toBe("OpenShot Video Editor 4.1.1");
    expect(entries[1]?.location).toBe("E:\\OpenShotVideoEditor\\");
  });

  it("keeps entries without an install location, with an empty location", () => {
    const entries = parseUninstallRegistry(FIXTURE);
    const third = entries[2];
    expect(third?.displayName).toBe("Something Without A Location");
    expect(third?.location).toBe("");
  });

  it("returns nothing for output that is not registry records", () => {
    expect(parseUninstallRegistry("")).toEqual([]);
    expect(
      parseUninstallRegistry("ERROR: The system was unable to find the specified registry key."),
    ).toEqual([]);
  });
});
