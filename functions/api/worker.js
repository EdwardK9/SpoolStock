/**
 * Simple health‑check worker.
 * Returns a JSON payload so the browser console shows a proper object.
 */

export default {
    async fetch(request) {
        return new Response(JSON.stringify({ status: "ok" }), {
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
        });
    },
};
