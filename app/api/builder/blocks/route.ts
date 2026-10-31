import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { describeBlocks } from "@/lib/builder/blocks";
import { PRESETS } from "@/lib/builder/presets";
import { FONTS, MAX_WIDTH_SCALE, RADIUS_SCALE } from "@/lib/builder/tokens";

/**
 * The block registry as data (`docs/API.md` §19, `docs/BUILDER.md` §5): every
 * insertable block's props schema, defaults and inspector fields, the presets,
 * and the token scales. The editor generates its inspector from this, and the
 * brand agent reads the same descriptions — one source for both.
 */
export const GET = orgHandler(
  async () =>
    NextResponse.json({
      blocks: describeBlocks(),
      presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, description: p.description })),
      tokens: { fonts: Object.keys(FONTS), radius: RADIUS_SCALE, maxWidth: MAX_WIDTH_SCALE },
    }),
  { permission: "cms.read" },
);
