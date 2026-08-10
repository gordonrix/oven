import globals from "globals";

export default [
    {
        // Extension host: CommonJS running in Node.
        files: ["extension.js", "src/**/*.js"],
        languageOptions: {
            globals: {
                ...globals.commonjs,
                ...globals.node,
            },
            ecmaVersion: 2022,
            sourceType: "commonjs",
        },
        rules: {
            "no-const-assign": "warn",
            "no-this-before-super": "warn",
            "no-undef": "warn",
            "no-unreachable": "warn",
            "no-unused-vars": "warn",
            "constructor-super": "warn",
            "valid-typeof": "warn",
        },
    },
    {
        // Webview scripts: browser globals, plus the VS Code webview bridge and
        // the globals the OVE bundle installs on window.
        files: ["media/cart*.js"],
        languageOptions: {
            globals: {
                ...globals.browser,
                acquireVsCodeApi: "readonly",
                module: "writable",
                CartShared: "readonly",
            },
            ecmaVersion: 2022,
            sourceType: "script",
        },
        rules: {
            "no-const-assign": "warn",
            "no-undef": "warn",
            "no-unreachable": "warn",
            "no-unused-vars": "warn",
            "valid-typeof": "warn",
        },
    },
    {
        files: ["test/unit/**/*.js"],
        languageOptions: {
            globals: { ...globals.commonjs, ...globals.node },
            ecmaVersion: 2022,
            sourceType: "commonjs",
        },
        rules: { "no-undef": "warn", "no-unused-vars": "warn" },
    },
    {
        // Vendored prebuilt bundles are not ours to lint.
        ignores: ["media/index.umd.js", "media/bioparser*.umd.js", "node_modules/**"],
    },
];
