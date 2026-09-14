#!/usr/bin/env node
/**
 * prepack guard: refuse to build a publishable tarball with a non-pnpm client.
 *
 * Every package in this workspace declares its internal dependencies with the
 * pnpm workspace protocol, e.g.
 *
 *     "@huanlin/dsh-plugin-codegraph-service": "workspace:^"
 *
 * Only pnpm rewrites that range to a concrete version while packing. npm ships
 * it verbatim, and the resulting tarball cannot be installed by anyone: a
 * `workspace:` range is only resolvable inside *this* workspace.
 *
 * That is what `-tree-sitter@0.1.12` shipped. Hooked as `prepack` rather than
 * `prepublishOnly` so it also covers `npm pack && npm publish <tarball>`, and so
 * a plain `npm pack` fails loudly instead of producing a dead artifact.
 *
 * Measured environment (pnpm 12.3.1 vs npm 12.0.2, Windows):
 *   pnpm : npm_config_user_agent = "pnpm/12.3.1 npm/? node/? win32 x64"
 *          npm_execpath         = "...\pnpm\pnpm.exe"
 *   npm  : npm_config_user_agent = "npm/12.0.2 node/v22.22.2 win32 x64 workspaces/false"
 *          npm_execpath         = "...\npm\bin\npm-cli.js"
 * `PNPM_HOME` is useless as a signal - npm inherits it from the shell too.
 */

const ua = process.env.npm_config_user_agent ?? "";
const execpath = process.env.npm_execpath ?? "";
const client = ua.split(/\s+/)[0] || "(unknown)";
const viaPnpm = /^pnpm\//.test(client) || /pnpm/i.test(execpath);

if (!viaPnpm) {
  console.error(
    [
      "",
      "  x refusing to pack: this workspace must be packed by pnpm",
      "",
      `    client     : ${client}`,
      `    user agent : ${ua || "(unset)"}`,
      `    execpath   : ${execpath || "(unset)"}`,
      "",
      "    npm does not rewrite `workspace:` ranges. Packing with it publishes a",
      "    tarball whose internal dependency range is unresolvable for consumers",
      "    (that is how -tree-sitter@0.1.12 broke every install through the bundle).",
      "",
      "    Use instead:",
      "      pnpm -r publish --access public --no-git-checks",
      "    or run the `Publish` workflow from the Actions tab.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
