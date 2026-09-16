import { z } from "zod";

/**
 * Money/size values cross the wire as decimal strings, never JSON numbers,
 * so precision is never lost to IEEE-754 floats (see the doc's recurring
 * warnings about float/precision bugs, e.g. the 18-vs-6-decimal incident).
 */
export const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "must be a decimal string, e.g. \"123.45\"");

export const isoDateTime = z.string().datetime({ offset: true });
