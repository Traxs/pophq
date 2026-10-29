/** A game name is not unique; always pair it with the exact Player ID in selection/review UI. */
export function PlayerIdentityLabel({ name, playerId }: { name: string; playerId: string }) {
  return <span className="member-text"><span>{name}</span><small className="muted">{playerId}</small></span>;
}
