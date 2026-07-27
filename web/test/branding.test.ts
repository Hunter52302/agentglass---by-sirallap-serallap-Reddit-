import { describe, expect, it } from "bun:test";
import { displaySourceApp } from "../src/lib/format.ts";

const header = await Bun.file(new URL("../src/components/Header.tsx", import.meta.url)).text();
const argus = await Bun.file(new URL("../src/components/ArgusCockpit.tsx", import.meta.url)).text();
const shell = await Bun.file(new URL("../../electron/package.json", import.meta.url)).json();

describe("Glasses for Argus branding", () => {
  it("credits agentglass and Argus with clickable creator links", () => {
    expect(header).toContain('href="https://github.com/SirAllap"');
    expect(header).toContain("SirAllap");
    expect(argus).toContain('href="https://github.com/git-Clem"');
    expect(argus).toContain("git-Clem");
  });

  it("uses the local application name for desktop builds", () => {
    expect(shell.build.productName).toBe("Glasses for Argus");
    expect(shell.build.executableName).toBe("glasses-for-argus");
  });

  it("hides the retired long repository slug without changing other app names", () => {
    expect(displaySourceApp("agentglass---by-sirallap-serallap-Reddit-")).toBe("Glasses for Argus");
    expect(displaySourceApp("Glasses-for-Argus")).toBe("Glasses for Argus");
    expect(displaySourceApp("magic_the_gathering")).toBe("magic_the_gathering");
  });
});
