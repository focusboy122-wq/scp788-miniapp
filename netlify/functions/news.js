// Runs server-side on Netlify, so it can fetch RSS feeds that don't allow
// direct browser (CORS) requests. Returns plain JSON for the frontend.

const Parser = require("rss-parser");
const parser = new Parser();

const DEFAULT_FEEDS = [
  "https://feeds.bbci.co.uk/sport/football/rss.xml",
  "https://feeds.bbci.co.uk/sport/rss.xml",
];

exports.handler = async (event) => {
  try {
    const query = (event.queryStringParameters && event.queryStringParameters.q) || null;
    const limit = parseInt((event.queryStringParameters && event.queryStringParameters.limit) || "6", 10);

    const feedUrls = process.env.NEWS_RSS_FEEDS
      ? process.env.NEWS_RSS_FEEDS.split(",").map((f) => f.trim()).filter(Boolean)
      : DEFAULT_FEEDS;

    const allItems = [];
    for (const url of feedUrls) {
      try {
        const feed = await parser.parseURL(url);
        for (const item of feed.items || []) {
          allItems.push({
            title: item.title || "",
            link: item.link || "",
            published: item.pubDate || "",
            summary: item.contentSnippet || item.summary || "",
          });
        }
      } catch (feedErr) {
        console.error(`Failed to fetch feed ${url}:`, feedErr.message);
      }
    }

    let results = allItems;
    if (query) {
      const q = query.toLowerCase();
      const filtered = allItems.filter(
        (i) => i.title.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q)
      );
      if (filtered.length > 0) {
        results = filtered;
      }
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
      body: JSON.stringify({ items: results.slice(0, limit) }),
    };
  } catch (err) {
    console.error("news function error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Failed to fetch news" }),
    };
  }
};
