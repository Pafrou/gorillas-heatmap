exports.handler = async function (event) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DB_ID = process.env.INTERACTIONS_DB_ID;

  if (!NOTION_TOKEN || !DB_ID) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing environment variables" }),
    };
  }

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  try {
    let allResults = [];
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const body = {
        page_size: 100,
        filter: {
          property: "Type",
          select: {
            is_not_empty: true,
          },
        },
      };
      if (startCursor) body.start_cursor = startCursor;

      const response = await fetch(
        `https://api.notion.com/v1/databases/${DB_ID}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${NOTION_TOKEN}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );

      if (!response.ok) {
        const err = await response.text();
        return { statusCode: response.status, headers, body: err };
      }

      const data = await response.json();
      allResults = allResults.concat(data.results);
      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    // Extract what we need: date, type, contact name, contact page URL
    const interactions = allResults.map((page) => {
      const props = page.properties;

      const type = props.Type?.select?.name || null;

      // Read from the correct formula property based on type
      let dateStr = null;
      if (type === "Meeting") {
        dateStr = props["Date Meeting"]?.formula?.string || null;
      } else if (type === "Call") {
        dateStr = props["Date Call"]?.formula?.string || null;
      } else if (type === "WhatsApp") {
        dateStr = props["Date WhatsApp"]?.formula?.string || null;
      } else if (type === "Email") {
        dateStr = props["Date Email"]?.formula?.string || null;
      }
      // Fallback to created_time if formula is empty
      if (!dateStr) {
        const fallback = props.Date?.created_time || page.created_time;
        dateStr = fallback ? fallback.substring(0, 10) : null;
      }

      // Contact relation — get first linked contact
      const contactRelation = props.Contact?.relation || [];
      const contactId = contactRelation.length > 0 ? contactRelation[0].id : null;

      // Contact name from rollup or title
      let contactName = null;
      if (props["Name"]?.title?.length > 0) {
        contactName = props["Name"].title.map((t) => t.plain_text).join("");
      }

      return {
        type,
        date: dateStr,
        contactName,
        contactId,
        contactUrl: contactId
          ? `https://www.notion.so/${contactId.replace(/-/g, "")}`
          : null,
      };
    }).filter((i) => i.type && i.date);

    // Group by contact
    const contactMap = {};
    for (const i of interactions) {
      const key = i.contactId || i.contactName || "Unknown";
      if (!contactMap[key]) {
        contactMap[key] = {
          name: i.contactName || "Unknown",
          url: i.contactUrl,
          interactions: [],
        };
      }
      contactMap[key].interactions.push({ date: i.date, type: i.type });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ contacts: Object.values(contactMap) }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
