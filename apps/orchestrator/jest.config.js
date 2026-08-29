export default {
  preset: "ts-jest/presets/default-esm",
  moduleNameMapper: {
    "^\\.\\./dist/utils/logger\\.js$": "<rootDir>/tests/mocks/logger.js",
    "^\\.\\./dist/utils/run-log\\.js$": "<rootDir>/tests/mocks/run-log.js",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
      },
    ],
  },
  extensionsToTreatAsEsm: [".ts"],
  setupFiles: ["dotenv/config", "./tests/setup-env.ts"],
  passWithNoTests: true,
  testTimeout: 20_000,
  testPathIgnorePatterns: ["<rootDir>/dist/"],
};
