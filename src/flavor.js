// Which app this build is.
//
//   harmonarium  The full app: shelf, lists, sheet sync, four looks, with the ReadEra-style look as a toggle.
//   solo         Scriptorium: the same reader engine as a standalone app that is only the
//                ReadEra-style reader. No lists, no sheet, no other looks. Built with
//                `npm run build:solo` (VITE_FLAVOR=solo, see .env.solo).

const env = (typeof import.meta !== "undefined" && import.meta.env) || {};

export const SOLO = env.VITE_FLAVOR === "solo";
export const APP_NAME = SOLO ? "Scriptorium" : "Harmonarium";
export const ICON = SOLO ? "/scriptorium.svg" : "/favicon.png";
