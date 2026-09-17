export function Panel({
  title,
  accent = true,
  children,
}: {
  title?: React.ReactNode;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--surface-card)",
        borderTop: accent ? "3px solid var(--border-accent)" : "1px solid var(--border-default)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-card)",
        padding: "var(--space-5)",
        fontFamily: "var(--font-body)",
      }}
    >
      {title && (
        <h3 style={{ fontSize: "var(--text-h3)", fontWeight: 700, marginBottom: "var(--space-4)" }}>{title}</h3>
      )}
      {children}
    </div>
  );
}
