import React from "react";

export const ChangeDiffStats = React.memo(function ChangeDiffStats({ additions, deletions }: {
  additions: number;
  deletions: number;
}) {
  return <span className="change-diff-stats">
    <span className="diff-stat-add">+{additions}</span>
    <span className="diff-stat-del">−{deletions}</span>
  </span>;
});