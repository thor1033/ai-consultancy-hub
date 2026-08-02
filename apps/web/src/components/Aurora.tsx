// The animated liquid-glass backdrop: three drifting blurred blobs over a masked
// grid. Purely decorative and non-interactive; sits behind all content.
export function Aurora() {
  return (
    <div className="aurora" aria-hidden>
      <div className="aurora-blob b1" />
      <div className="aurora-blob b2" />
      <div className="aurora-blob b3" />
    </div>
  );
}
