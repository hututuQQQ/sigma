export interface UnsupportedSchemaVersionError extends Error {
  code: "unsupported_schema_version";
  path: string;
  expected: number;
  actual: unknown;
}

export function unsupportedSchemaVersion(
  label: string,
  path: string,
  expected: number,
  actual: unknown
): UnsupportedSchemaVersionError {
  return Object.assign(
    new Error(
      `unsupported_schema_version: ${label} expected ${expected}, received ${String(actual)} at ${path}; existing data was not modified`
    ),
    { code: "unsupported_schema_version" as const, path, expected, actual }
  );
}
