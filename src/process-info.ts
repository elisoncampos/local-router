function tokenizeCommand(command: string): string[] {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) => {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1);
    }

    return token;
  });
}

function isLocalRouterToken(token: string): boolean {
  return (
    token.endsWith("/local-router") ||
    token === "local-router" ||
    token.endsWith("/cli.js") ||
    token.endsWith("/cli.ts") ||
    token.includes("@elisoncampos/local-router/")
  );
}

export function extractChildCommandFromProcessCommand(command: string): string | undefined {
  const tokens = tokenizeCommand(command.trim());
  if (tokens.length === 0) return undefined;

  const runIndex = tokens.findIndex((token, index) => {
    if (token !== "run") return false;
    return tokens.slice(0, index).some(isLocalRouterToken);
  });

  if (runIndex === -1) return undefined;

  const childTokens = tokens.slice(runIndex + 1).filter((token, index) => !(index === 0 && token === "--"));
  if (childTokens.length === 0) return undefined;

  return childTokens.join(" ");
}
