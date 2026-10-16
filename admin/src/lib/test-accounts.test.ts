import { describe, expect, it } from "vitest";

import {
  devLoginEnabled,
  isDevLoginRole,
  showTestAccountsInTeam,
  testAccountsAllowed,
} from "./test-accounts";

const prod = { NODE_ENV: "production" };
const dev = { NODE_ENV: "development" };

describe("devLoginEnabled", () => {
  it("solo con la variable, y nunca en producción", () => {
    expect(devLoginEnabled(dev)).toBe(false);
    expect(devLoginEnabled({ ...dev, DEV_LOGIN: "1" })).toBe(true);
    expect(devLoginEnabled({ ...prod, DEV_LOGIN: "1" })).toBe(false);
    expect(devLoginEnabled({ ...dev, DEV_LOGIN: "true" })).toBe(false);
  });
});

describe("testAccountsAllowed", () => {
  it("en desarrollo, sí", () => expect(testAccountsAllowed(dev)).toBe(true));
  it("en producción, no", () => expect(testAccountsAllowed(prod)).toBe(false));
  it("en producción solo con la excepción del CI", () =>
    expect(testAccountsAllowed({ ...prod, ALLOW_TEST_ACCOUNTS: "1" })).toBe(true));
});

describe("showTestAccountsInTeam", () => {
  it("escondidas por defecto, también en desarrollo", () =>
    expect(showTestAccountsInTeam(dev)).toBe(false));
  it("visibles solo si se piden fuera de producción", () => {
    expect(showTestAccountsInTeam({ ...dev, SHOW_TEST_ACCOUNTS: "1" })).toBe(true);
    expect(showTestAccountsInTeam({ ...prod, SHOW_TEST_ACCOUNTS: "1" })).toBe(false);
  });
});

it("isDevLoginRole acepta los tres roles y nada más", () => {
  expect(["owner", "admin", "staff"].every(isDevLoginRole)).toBe(true);
  expect(isDevLoginRole("root")).toBe(false);
});
