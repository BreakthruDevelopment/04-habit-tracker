type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const level = (process.env.LOG_LEVEL as Level | undefined) ?? "info";
  return order[level] ?? order.info;
}

/**
 * One JSON object per line on stdout/stderr. Every cloud's log service
 * (CloudWatch, Azure Monitor, Cloud Logging, OCI Logging) parses this as-is.
 */
function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (order[level] < threshold()) return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    severity: level.toUpperCase(),
    msg,
    ...fields,
  });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
