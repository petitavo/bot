import { describe, expect, it } from "vitest";
import { isAllowed, normalizePhone, signToken, verifyToken } from "../src/security.js";
import { formatLocal, isoLocal, nextOccurrence, parseLocal } from "../src/time.js";
import { insideSessionWindow, splitMessage } from "../src/whatsapp.js";
import type { User } from "../src/db/index.js";

describe("time", () => {
  it("interpreta la hora en la zona del usuario", () => {
    const d = parseLocal("2026-10-09T15:00", "America/Lima"); // Lima = UTC-5
    expect(d.toISOString()).toBe("2026-10-09T20:00:00.000Z");
    expect(isoLocal(d, "America/Lima")).toBe("2026-10-09T15:00");
  });

  it("respeta una zona explícita", () => {
    expect(parseLocal("2026-10-09T15:00Z", "America/Lima").toISOString()).toBe("2026-10-09T15:00:00.000Z");
  });

  it("rechaza fechas inválidas", () => {
    expect(() => parseLocal("mañana", "America/Lima")).toThrow(/Fecha inválida/);
  });

  it("formatea en español", () => {
    expect(formatLocal(new Date("2026-10-09T20:00:00Z"), "America/Lima")).toBe("viernes 9 de octubre, 15:00");
  });

  it("calcula la siguiente repetición", () => {
    const tz = "America/Lima";
    const friday = parseLocal("2026-10-09T08:00", tz);
    const after = parseLocal("2026-10-09T08:01", tz);
    expect(nextOccurrence(friday, "none", tz, after)).toBeNull();
    expect(isoLocal(nextOccurrence(friday, "daily", tz, after)!, tz)).toBe("2026-10-10T08:00");
    expect(isoLocal(nextOccurrence(friday, "weekdays", tz, after)!, tz)).toBe("2026-10-12T08:00"); // lunes
    expect(isoLocal(nextOccurrence(friday, "weekly", tz, after)!, tz)).toBe("2026-10-16T08:00");
    expect(isoLocal(nextOccurrence(friday, "monthly", tz, after)!, tz)).toBe("2026-11-09T08:00");
  });

  it("salta repeticiones atrasadas (si el servidor estuvo apagado)", () => {
    const tz = "America/Lima";
    const old = parseLocal("2026-10-01T08:00", tz);
    const now = parseLocal("2026-10-04T09:00", tz);
    expect(isoLocal(nextOccurrence(old, "daily", tz, now)!, tz)).toBe("2026-10-05T08:00");
  });
});

describe("security", () => {
  it("firma y verifica tokens", () => {
    const t = signToken("s", { uid: 7 }, 60);
    expect(verifyToken<{ uid: number }>("s", t)?.uid).toBe(7);
    expect(verifyToken("otro", t)).toBeNull();
    expect(verifyToken("s", t.slice(0, -2) + "xx")).toBeNull();
  });

  it("los tokens caducan", () => {
    const t = signToken("s", { uid: 7 }, 60, Date.now() - 120_000);
    expect(verifyToken("s", t)).toBeNull();
  });

  it("normaliza teléfonos", () => {
    expect(normalizePhone("whatsapp:+51 987-654-321")).toBe("+51987654321");
    expect(normalizePhone("51987654321")).toBe("+51987654321");
    expect(isAllowed([], "+1")).toBe(true);
    expect(isAllowed(["+51987654321"], "whatsapp:+51987654321")).toBe(true);
    expect(isAllowed(["+51987654321"], "whatsapp:+51900000000")).toBe(false);
  });
});

describe("whatsapp", () => {
  it("parte mensajes largos", () => {
    const long = Array.from({ length: 200 }, (_, i) => `línea ${i} con algo de texto`).join("\n");
    const parts = splitMessage(long, 500);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
    expect(parts.join("\n")).toBe(long);
  });

  it("sabe si la ventana de 24 h está abierta", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    const user = { last_inbound_at: new Date("2026-10-04T00:00:00Z") } as User;
    expect(insideSessionWindow(user, now)).toBe(true);
    expect(insideSessionWindow({ ...user, last_inbound_at: new Date("2026-10-03T11:00:00Z") }, now)).toBe(false);
    expect(insideSessionWindow({ ...user, last_inbound_at: null }, now)).toBe(false);
  });
});
