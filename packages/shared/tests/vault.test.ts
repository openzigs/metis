import { describe, expect, it } from "vitest";
import { createSecretSchema, secretSchema, storeSecretSchema } from "../src/vault.js";

const validId = "clxxxxxxxx0000abcd1234efgh";
const now = new Date();

const sampleEncrypted = {
  ciphertext: "AAAAAAAAAAAAAAAA",
  iv: "BBBBBBBBBBBB",
  tag: "CCCCCCCCCCCC",
  salt: "DDDDDDDDDDDD",
};

describe("vault domain", () => {
  describe("createSecretSchema", () => {
    it("accepts a valid plaintext payload", () => {
      expect(
        createSecretSchema.parse({
          name: "github/pat",
          plaintext: "ghp_abc123",
        }),
      ).toMatchObject({ name: "github/pat" });
    });

    it("rejects an empty plaintext", () => {
      expect(() => createSecretSchema.parse({ name: "x", plaintext: "" })).toThrow();
    });

    it("rejects a name with illegal characters", () => {
      expect(() => createSecretSchema.parse({ name: "bad name!", plaintext: "x" })).toThrow();
    });
  });

  describe("storeSecretSchema", () => {
    it("accepts an encrypted row payload", () => {
      expect(
        storeSecretSchema.parse({
          name: "github/pat",
          ...sampleEncrypted,
          keyVersion: 1,
          algorithm: "aes-256-gcm",
        }),
      ).toMatchObject({ algorithm: "aes-256-gcm" });
    });

    it("rejects ciphertext containing whitespace", () => {
      expect(() =>
        storeSecretSchema.parse({
          name: "x",
          ...sampleEncrypted,
          ciphertext: "has space",
          keyVersion: 1,
          algorithm: "aes-256-gcm",
        }),
      ).toThrow();
    });

    it("rejects keyVersion=0", () => {
      expect(() =>
        storeSecretSchema.parse({
          name: "x",
          ...sampleEncrypted,
          keyVersion: 0,
          algorithm: "aes-256-gcm",
        }),
      ).toThrow();
    });
  });

  describe("secretSchema", () => {
    it("validates a hydrated row", () => {
      expect(
        secretSchema.parse({
          id: validId,
          name: "github/pat",
          description: "",
          ...sampleEncrypted,
          keyVersion: 1,
          algorithm: "aes-256-gcm",
          createdById: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toMatchObject({ keyVersion: 1 });
    });
  });
});
