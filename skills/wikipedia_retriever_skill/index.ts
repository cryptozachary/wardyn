export const parameters = {
  type: "object",
  properties: {
    page: { type: "string", description: "Exact Wikipedia page title to retrieve" },
    search: { type: "string", description: "Search term to find Wikipedia pages" }
  },
  required: []
};

export async function execute(args: any): Promise<string> {
  const { page, search } = args;

  const apiUrl = "https://en.wikipedia.org/w/api.php";
  let params: { [key: string]: any } = {};

  if (page) {
    params = {
      action: "query",
      prop: "revisions",
      titles: page,
      rvprop: "content",
      format: "json"
    };
  } else if (search) {
    params = {
      action: "query",
      list: "search",
      srsearch: search,
      format: "json"
    };
  } else {
    return "Please provide either a page title or search term";
  }

  try {
    const queryString = new URLSearchParams(params).toString();
    const response = await fetch(`${apiUrl}?${queryString}`);
    const data = await response.json();

    if (page) {
      const pages = data.query.pages;
      const [pageId] = Object.keys(pages);
      return pages[pageId].revisions[0].content;
    } else {
      const results = data.query.search.map((item: any) => ({
        title: item.title,
        snippet: item.snippet,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title)}`
      }));
      return JSON.stringify(results, null, 2);
    }
  } catch (error: any) {
    return "Error retrieving data from Wikipedia: " + error.message;
  }
}