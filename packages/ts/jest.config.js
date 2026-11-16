/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true }] },
  testMatch: ['<rootDir>/test/**/*.test.ts'],
}
