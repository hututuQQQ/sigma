const fs = require("node:fs");
const path = require("node:path");

const packagesDirectory = path.join(__dirname, "packages");
const packageNames = fs
  .readdirSync(packagesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(packagesDirectory, entry.name, "package.json")))
  .map((entry) => entry.name)
  .sort();

const crossPackageSourceRules = packageNames.map((targetPackage) => ({
  name: `no-cross-package-source-import-${targetPackage}`,
  comment: `Consumers of ${targetPackage} must use its public package export.`,
  severity: "error",
  from: {
    path: `^packages/(?!${targetPackage}/)`,
  },
  to: {
    path: `^packages/${targetPackage}/src(?:/|$)`,
  },
}));

module.exports = {
  forbidden: [
    {
      name: "no-package-cycles",
      comment: "Production package dependencies must remain acyclic.",
      severity: "error",
      from: { path: "^packages/" },
      to: { circular: true, path: "^packages/" },
    },
    ...crossPackageSourceRules,
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    exclude: "(^|/)(dist|node_modules)/",
    includeOnly: "^packages/",
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["types", "import", "default"],
    },
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/[^/]+",
      },
    },
  },
};
