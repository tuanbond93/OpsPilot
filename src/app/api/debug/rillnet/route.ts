import { NextResponse } from "next/server";
import { RillnetConnector, RillnetError } from "@/connectors/rillnet";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const connector = new RillnetConnector();
    const summary = await connector.fetchDebugSummary();

    return NextResponse.json(summary);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const errorType = err instanceof RillnetError ? err.name : "InternalError";

    return NextResponse.json(
      {
        error: errorType,
        message,
      },
      { status: 500 }
    );
  }
}
