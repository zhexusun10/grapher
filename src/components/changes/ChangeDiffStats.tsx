import React from "react";

export const ChangeDiffStats = React.memo(function ChangeDiffStats({
  additions,
  deletions,
  hideZero = false,
}: {
  additions: number;
  deletions: number;
  hideZero?: boolean;
}) {
  const showAdd = !hideZero || additions > 0;
  const showDel = !hideZero || deletions > 0;
  if (!showAdd && !showDel) return null;
  return <span className="change-diff-stats">
    {showAdd && <span className="diff-stat-add">+{additions}</span>}
    {showDel && <span className="diff-stat-del">−{deletions}</span>}
  </span>;
});
