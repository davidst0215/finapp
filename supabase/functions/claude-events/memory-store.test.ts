// Corre en Node: node --experimental-strip-types --test supabase/functions/claude-events/memory-store.test.ts
// El almacén en memoria con el que se prueban los manejadores debe cumplir el mismo contrato que la base.
import { MemoryStore } from "./memory-store.ts";
import { defineStoreContract } from "./store-contract.ts";

defineStoreContract("MemoryStore", async () => ({ store: new MemoryStore(), seedUser: async () => {} }));
