// Copied from hasky00/cinderella@a94ab62 (src/policy.ts, NostrEvent only).

export interface NostrEvent {
  id         : string
  pubkey     : string
  created_at : number
  kind       : number
  tags       : string[][]
  content    : string
  sig?       : string
}
