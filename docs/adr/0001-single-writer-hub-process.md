# One hub process writes the store; everything else reads

All Adapters run inside a single long-lived hub process, which is the only writer to the SQLite store (WAL mode). The HTTP API lives in that same process. The MCP server is a separate process that opens the store read-only, because MCP clients launch their servers themselves and should not be able to reach the Adapters or write anything. We rejected one process per Adapter writing to a shared file: it multiplies daemons to supervise and turns every new Source into a concurrency question instead of one more Adapter.
