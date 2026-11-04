/* global module */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.base.json' }],
  },
  moduleNameMapper: {
    '^@mini-scan/shared$': '<rootDir>/packages/shared/src/index.ts',
  },
  collectCoverageFrom: [
    'services/api/src/scans/hash.ts',
    'services/api/src/auth/sessions.ts',
    'services/worker/src/scanner.ts',
    'services/worker/src/repository.ts',
    'packages/shared/src/retries.ts',
  ],
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
};
