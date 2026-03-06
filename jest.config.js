module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+\.tsx?$': 'ts-jest',
  },
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '<rootDir>/packages/'],
  moduleNameMapper: {
    '^cloudflare:workers$': '<rootDir>/__mocks__/cloudflare-workers.js',
  },
};
