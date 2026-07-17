import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("theme token alignment", () => {
  const themeCss = readFileSync(
    resolve(__dirname, "../../kylins.client.frontend/src/styles/theme.css"),
    "utf8",
  );
  const tokensCss = readFileSync(
    resolve(__dirname, "../../assets/design-tokens.css"),
    "utf8",
  );

  it("has matching primary colors", () => {
    expect(tokensCss).toContain("--color-primary:");
    expect(themeCss).toContain("--primary:");
  });

  it("declares all required semantic tokens", () => {
    const required = [
      "--color-background",
      "--color-foreground",
      "--color-surface",
      "--color-chrome",
      "--color-border",
      "--color-muted",
      "--color-primary",
      "--color-destructive",
    ];
    for (const token of required) {
      expect(tokensCss).toContain(`${token}:`);
    }
  });

  it("declares component tokens in theme.css", () => {
    const componentTokens = [
      "--button-primary-bg",
      "--button-secondary-bg-hover",
      "--input-bg",
      "--list-row-selected-bg",
      "--ribbon-bg",
      "--statusbar-bg",
    ];
    for (const token of componentTokens) {
      expect(themeCss).toContain(`${token}:`);
    }
  });
});
