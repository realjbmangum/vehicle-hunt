import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
  try {
    const db = (locals as any).runtime?.env?.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: 'Database not available' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const result = await db.prepare('SELECT * FROM listings ORDER BY updated_at DESC').all();
    return new Response(JSON.stringify(result.results), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const db = (locals as any).runtime?.env?.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: 'Database not available' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = await request.json();

    const columns = [
      'year', 'trim', 'price', 'mileage', 'vin', 'color',
      'drivetrain', 'bed_size', 'cab_type', 'dealer_name',
      'dealer_location', 'contact_info', 'listing_url',
      'features', 'photos', 'status', 'notes'
    ];

    const presentColumns = columns.filter(col => data[col] !== undefined);
    const placeholders = presentColumns.map(() => '?').join(', ');
    const values = presentColumns.map(col => data[col]);

    const sql = `INSERT INTO listings (${presentColumns.join(', ')}) VALUES (${placeholders})`;
    const result = await db.prepare(sql).bind(...values).run();

    return new Response(JSON.stringify({ success: true, id: result.meta.last_row_id }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
