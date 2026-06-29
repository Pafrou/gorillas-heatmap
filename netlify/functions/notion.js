// v2
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

  // Build week lookup: date string -> week index (0-based, Jan 1 week = 0)
  const year = new Date().getFullYear();
  const jan1 = new Date(year, 0, 1);
  const dow0 = jan1.getDay();
  const toMon = dow0 === 0 ? 6 : dow0 - 1;
  const firstMon = new Date(jan1);
  firstMon.setDate(jan1.getDate() - toMon);

  const dec31 = new Date(year, 11, 31);
  const dowD = dec31.getDay();
  const toMonD = dowD === 0 ? 6 : dowD - 1;
  const lastMon = new Date(dec31);
  lastMon.setDate(dec31.getDate() - toMonD);

  const ms7 = 7 * 86400000;
  const nWeeks = Math.round((lastMon - firstMon) / ms7) + 1;

  // Build date->weekIndex map for the entire year
  const dateToWeek = {};
  for (let w = 0; w < nWeeks; w++) {
    for (let d = 0; d < 7; d++) {
      const dt = new Date(firstMon);
      dt.setDate(firstMon.getDate() + w * 7 + d);
      if (dt.getFullYear() === year) {
        const ds = dt.toISOString().substring(0, 10);
        dateToWeek[ds] = w;
      }
    }
  }

  try {
    let allResults = [];
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const body = {
        page_size: 100,
        filter: { property: "Type", select: { is_not_empty: true } },
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

    const interactions = allResults.map((page) => {
      const props = page.properties;
      const type = props.Type?.select?.name || null;

      // Read from correct formula property based on type
      let dateStr = null;
      if (type === "Meeting") dateStr = props["Date Meeting"]?.formula?.string || null;
      else if (type === "Call") dateStr = props["Date Call"]?.formula?.string || null;
      else if (type === "WhatsApp") dateStr = props["Date WhatsApp"]?.formula?.string || null;
      else if (type === "Email") dateStr = props["Date Email"]?.formula?.string || null;

      // Fallback to created_time
      if (!dateStr) {
        const fallback = props.Date?.created_time || page.created_time;
        dateStr = fallback ? fallback.substring(0, 10) : null;
      }

      const contactRelation = props.Contact?.relation || [];
      const contactId = contactRelation.length > 0 ? contactRelation[0].id : null;

      let contactName = null;
      if (props["Name"]?.title?.length > 0) {
        contactName = props["Name"].title.map((t) => t.plain_text).join("");
      }

      // Convert date to week index
      const weekIndex = dateStr && dateToWeek[dateStr] !== undefined ? dateToWeek[dateStr] : null;

      return {
        type,
        date: dateStr,
        weekIndex,
        contactName,
        contactId,
        contactUrl: contactId
          ? `https://www.notion.so/${contactId.replace(/-/g, "")}`
          : null,
      };
    }).filter((i) => i.type && i.weekIndex !== null);

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
      contactMap[key].interactions.push({ weekIndex: i.weekIndex, type: i.type, date: i.date });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        contacts: Object.values(contactMap),
        nWeeks,
        year,
        // Send month label positions for the HTML to use
        monthLabels: (() => {
          const labels = [];
          let lastMonth = -1;
          for (let w = 0; w < nWeeks; w++) {
            const days = [];
            for (let d = 0; d < 7; d++) {
              const dt = new Date(firstMon);
              dt.setDate(firstMon.getDate() + w * 7 + d);
              if (dt.getFullYear() === year) days.push(dt);
            }
            if (days.length > 0) {
              const m = days[0].getMonth();
              labels.push(m !== lastMonth ? days[0].toLocaleString('en', { month: 'short' }) : '');
              if (m !== lastMonth) lastMonth = m;
            } else {
              labels.push('');
            }
          }
          return labels;
        })()
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
