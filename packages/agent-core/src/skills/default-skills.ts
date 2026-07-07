import type { AgentSkill } from "./types.js";

export const DEFAULT_SKILLS: AgentSkill[] = [
  {
    name: "python-packaging-and-pytest",
    source: "built-in",
    triggers: ["python", "pytest", "pyproject", "requirements", "setup.py", "uv", "tox"],
    summary: "Work on Python packages by checking metadata, imports, and the narrowest pytest or compile target first.",
    inspectSteps: [
      "Inspect pyproject.toml, requirements.txt, setup.py, pytest.ini, and nearby tests before editing.",
      "Identify the package root and import style before moving files or changing module names."
    ],
    implementSteps: [
      "Keep dependency and packaging edits minimal.",
      "Prefer fixing the source or test target directly over broad path hacks."
    ],
    verifySteps: [
      "Run python -m py_compile for changed Python files when tests are unavailable.",
      "Run python -m pytest -q, or uv run pytest -q when the workspace uses uv."
    ]
  },
  {
    name: "node-typescript",
    source: "built-in",
    triggers: ["node", "typescript", "javascript", "package.json", "tsconfig", "npm", "pnpm", "yarn", "bun"],
    summary: "Use package metadata to choose scripts and validate JavaScript or TypeScript changes.",
    inspectSteps: [
      "Read package.json scripts and tsconfig.json before choosing commands.",
      "Use the lockfile to infer the package manager."
    ],
    implementSteps: [
      "Follow existing module style and avoid changing package manager defaults.",
      "Prefer package scripts over ad hoc commands when scripts exist."
    ],
    verifySteps: [
      "Run the relevant package test script when present.",
      "Run build or tsc --noEmit for TypeScript changes when available."
    ]
  },
  {
    name: "go-rust-java-tests",
    source: "built-in",
    triggers: ["go.mod", "golang", "cargo", "rust", "maven", "gradle", "java", "pom.xml"],
    summary: "Use each compiled language workspace's standard test command and keep edits within package boundaries.",
    inspectSteps: [
      "Inspect go.mod, Cargo.toml, pom.xml, or Gradle files to locate the project root.",
      "Check nearby tests and public interfaces before editing shared code."
    ],
    implementSteps: [
      "Keep API changes compatible unless the task asks otherwise.",
      "Avoid broad formatting churn across unrelated packages."
    ],
    verifySteps: [
      "Use go test ./... for Go, cargo test for Rust, mvn test -q for Maven, and Gradle test for Gradle projects."
    ]
  },
  {
    name: "linux-services-and-ports",
    source: "built-in",
    triggers: ["service", "server", "daemon", "port", "localhost", "curl", "http"],
    summary: "Treat long-running processes as managed services and verify readiness explicitly.",
    inspectSteps: [
      "Find the command, port, and readiness endpoint before starting a service.",
      "Check existing logs and process state before assuming a port is free."
    ],
    implementSteps: [
      "Use the service tool for long-running servers.",
      "Keep temporary service names and logs workspace-contained."
    ],
    verifySteps: [
      "Use service status/logs and a direct readiness command such as curl against localhost."
    ]
  },
  {
    name: "openssl-certificates",
    source: "built-in",
    triggers: ["openssl", "certificate", "cert", "pem", "x509", "tls", "ssl", "key"],
    summary: "Inspect certificate formats and verify generated keys or chains with OpenSSL.",
    inspectSteps: [
      "Check expected input and output formats before converting certificates.",
      "Inspect certificate subjects, SANs, dates, and key usage when relevant."
    ],
    implementSteps: [
      "Avoid printing private key material in final summaries or logs.",
      "Keep generated files named by role and format."
    ],
    verifySteps: [
      "Run openssl x509, verify, rsa, pkey, or pkcs12 checks appropriate to the file type."
    ]
  },
  {
    name: "archives-and-compression",
    source: "built-in",
    triggers: ["zip", "tar", "gzip", "archive", "compress", "extract", "unpack"],
    summary: "Handle archives by listing contents first and round-tripping important outputs.",
    inspectSteps: [
      "List archive contents before extracting when possible.",
      "Confirm target directories and avoid overwriting unrelated files."
    ],
    implementSteps: [
      "Preserve paths and permissions only when the task requires them.",
      "Use workspace-contained extraction directories."
    ],
    verifySteps: [
      "List the resulting archive or extracted files and compare expected paths."
    ]
  },
  {
    name: "data-processing-and-roundtrip-checks",
    source: "built-in",
    triggers: ["csv", "json", "yaml", "xml", "parquet", "data", "parse", "convert", "roundtrip"],
    summary: "For data transforms, inspect schema and verify by parsing or round-tripping a sample.",
    inspectSteps: [
      "Look at headers, encodings, delimiters, and representative rows before coding.",
      "Identify whether ordering, nulls, numeric precision, or dates matter."
    ],
    implementSteps: [
      "Use structured parsers when available instead of brittle string splitting.",
      "Keep conversion logic deterministic and bounded for large files."
    ],
    verifySteps: [
      "Parse the output with the target parser and compare counts or key fields against input expectations."
    ]
  },
  {
    name: "ml-training-small-sample-first",
    source: "built-in",
    triggers: ["machine learning", "ml", "training", "dataset", "model", "epoch", "cuda", "torch", "tensorflow"],
    summary: "Debug ML training by using small samples and quick checks before long runs.",
    inspectSteps: [
      "Inspect dataset shape, labels, and config defaults before editing training loops.",
      "Check device, seed, batch size, and output paths."
    ],
    implementSteps: [
      "Add quick sanity paths without changing production defaults unless asked.",
      "Keep long training runs out of verification unless the task requires them."
    ],
    verifySteps: [
      "Run a tiny batch or single-epoch smoke check and confirm metrics or output artifacts are produced."
    ]
  }
];
