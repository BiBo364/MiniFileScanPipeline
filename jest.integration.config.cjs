/* global module */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.base.json' }],
  },
  moduleNameMapper: {
    '^@mini-scan/shared$': '<rootDir>/packages/shared/src/index.ts',
  },
};
