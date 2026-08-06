import type { APIRoute } from 'astro';

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export const OPTIONS: APIRoute = async () => {
  return new Response(null, { status: 204, headers: corsHeaders });
};

export const GET: APIRoute = async ({ params, locals }) => {
  try {
    const db = (locals as any).runtime?.env?.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: 'Database not available' }), {
        status: 500,
        headers: corsHeaders
      });
    }

    const result = await db.prepare('SELECT * FROM listings WHERE id = ?').bind(params.id).first();

    if (!result) {
      return new Response(JSON.stringify({ error: 'Listing not found' }), {
        status: 404,
        headers: corsHeaders
      });
    }

    return new Response(JSON.stringify(result), {
      headers: corsHeaders
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders
    });
  }
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  try {
    const db = (locals as any).runtime?.env?.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: 'Database not available' }), {
        status: 500,
        headers: corsHeaders
      });
    }

    const data = await request.json();

    const columns = [
      'year', 'trim', 'price', 'mileage', 'vin', 'color',
      'drivetrain', 'bed_size', 'cab_type', 'dealer_name',
      'dealer_location', 'contact_info', 'listing_url',
      'features', 'photos', 'status', 'notes'
    ];

    const updates: string[] = [];
    const values: any[] = [];

    columns.forEach(col => {
      if (data[col] !== undefined) {
        updates.push(`${col} = ?`);
        values.push(data[col]);
      }
    });

    if (updates.length === 0) {
      return new Response(JSON.stringify({ error: 'No fields to update' }), {
        status: 400,
        headers: corsHeaders
      });
    }

    updates.push("updated_at = datetime('now')");
    values.push(params.id);

    const sql = `UPDATE listings SET ${updates.join(', ')} WHERE id = ?`;
    await db.prepare(sql).bind(...values).run();

    return new Response(JSON.stringify({ success: true }), {
      headers: corsHeaders
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders
    });
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  try {
    const db = (locals as any).runtime?.env?.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: 'Database not available' }), {
        status: 500,
        headers: corsHeaders
      });
    }

    await db.prepare('DELETE FROM listings WHERE id = ?').bind(params.id).run();

    return new Response(JSON.stringify({ success: true }), {
      headers: corsHeaders
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders
    });
  }
};
