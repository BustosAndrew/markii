import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { describeBindings } from "@markii/renderer/bindings";
import { describeBlocks } from "@markii/renderer/blocks";
import { PRESETS } from "@markii/renderer/presets";
import { FONTS, MAX_WIDTH_SCALE, RADIUS_SCALE } from "@markii/renderer/tokens";

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
      // M4: the binding paths, visibility conditions and repeater sources — the whole whitelist.
      data: describeBindings(),
    }),
  { permission: "cms.read" },
);
