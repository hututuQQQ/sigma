type GlobToken =
  | { kind: "literal"; value: string }
  | { kind: "one" | "star" | "globstar" | "globstarDirectory" };

function tokenize(pattern: string): GlobToken[] {
  const normalized = pattern.replaceAll("\\", "/");
  const tokens: GlobToken[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        tokens.push({ kind: "globstarDirectory" });
        index += 2;
      } else {
        tokens.push({ kind: "globstar" });
        index += 1;
      }
    } else if (character === "*") {
      tokens.push({ kind: "star" });
    } else if (character === "?") {
      tokens.push({ kind: "one" });
    } else {
      tokens.push({ kind: "literal", value: character });
    }
  }
  return tokens;
}

function advanceSingle(token: GlobToken, value: string, current: boolean[]): boolean[] {
  const next = Array.from({ length: value.length + 1 }, () => false);
  for (let index = 0; index < value.length; index += 1) {
    if (!current[index]) continue;
    if (token.kind === "literal"
      ? value[index] === token.value
      : value[index] !== "/") next[index + 1] = true;
  }
  return next;
}

function advanceStar(token: GlobToken, value: string, current: boolean[]): boolean[] {
  const next = Array.from({ length: value.length + 1 }, () => false);
  next[0] = current[0] ?? false;
  for (let index = 1; index <= value.length; index += 1) {
    next[index] = Boolean(current[index]) || (
      next[index - 1]! && (token.kind === "globstar" || value[index - 1] !== "/")
    );
  }
  return next;
}

function advanceGlobstarDirectory(value: string, current: boolean[]): boolean[] {
  const next = Array.from({ length: value.length + 1 }, () => false);
  for (let index = 0; index <= value.length; index += 1) {
    if (current[index]) next[index] = true;
  }
  let active = false;
  for (let index = 0; index < value.length; index += 1) {
    active ||= Boolean(current[index]);
    if (active && value[index] === "/") next[index + 1] = true;
  }
  return next;
}

function advance(token: GlobToken, value: string, current: boolean[]): boolean[] {
  if (token.kind === "literal" || token.kind === "one") {
    return advanceSingle(token, value, current);
  }
  if (token.kind === "star" || token.kind === "globstar") {
    return advanceStar(token, value, current);
  }
  return advanceGlobstarDirectory(value, current);
}

/** Matches repository paths with bounded `*`, `?`, and zero-or-more-level `**` semantics. */
export function repositoryGlobMatches(pattern: string, candidate: string): boolean {
  return compileRepositoryGlob(pattern)(candidate);
}

export function compileRepositoryGlob(pattern: string): (candidate: string) => boolean {
  const tokens = tokenize(pattern);
  return (candidate: string): boolean => {
    const value = candidate.replaceAll("\\", "/");
    let positions = Array.from({ length: value.length + 1 }, (_, index) => index === 0);
    for (const token of tokens) positions = advance(token, value, positions);
    return positions[value.length] ?? false;
  };
}
