const tones: Record<string, { bg: string; fg: string }> = {
  success: { bg: "var(--color-success)", fg: "#fff" },
  danger: { bg: "var(--color-danger)", fg: "#fff" },
  warning: { bg: "var(--color-accent)", fg: "#1C1C1C" },
  neutral: { bg: "var(--surface-sunken)", fg: "var(--color-ink)" },
};

export function StatusBadge({ tone = "neutral", children }: { tone?: keyof typeof tones; children: React.ReactNode }) {
  const t = tones[tone] ?? tones.neutral;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        background: t.bg,
        color: t.fg,
        fontFamily: "var(--font-body)",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        padding: "4px 9px",
        borderRadius: "var(--radius-sm)",
      }}
    >
      {children}
    </span>
  );
}
