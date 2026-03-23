const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = 3201;

// PostgreSQL connection
const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT) || 54329,
  user: process.env.DB_USER || 'paperclip',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'paperclip'
});

// ============================================
// API HANDLERS
// ============================================

async function getAgents() {
  const result = await pool.query(`
    SELECT id, name, role, title, status, icon, last_heartbeat_at
    FROM agents
    ORDER BY name
  `);
  return result.rows;
}

async function getTimeline(params) {
  const limit = Math.min(parseInt(params.get('limit')) || 50, 200);
  const offset = parseInt(params.get('offset')) || 0;
  const agentId = params.get('agent');
  const status = params.get('status');
  const since = params.get('since');
  const type = params.get('type') || 'all';

  let events = [];

  // Get heartbeat runs
  if (type === 'all' || type === 'runs') {
    let runQuery = `
      SELECT 
        hr.id,
        hr.agent_id,
        a.name as agent_name,
        a.icon as agent_icon,
        hr.status,
        hr.invocation_source,
        hr.trigger_detail,
        hr.started_at,
        hr.finished_at,
        hr.error,
        hr.error_code,
        hr.exit_code,
        hr.usage_json,
        hr.result_json,
        hr.context_snapshot,
        'run' as event_type
      FROM heartbeat_runs hr
      LEFT JOIN agents a ON hr.agent_id = a.id
      WHERE 1=1
    `;
    const runParams = [];
    let paramIdx = 1;

    if (agentId) {
      runQuery += ` AND hr.agent_id = $${paramIdx++}`;
      runParams.push(agentId);
    }
    if (status) {
      runQuery += ` AND hr.status = $${paramIdx++}`;
      runParams.push(status);
    }
    if (since) {
      runQuery += ` AND hr.started_at >= $${paramIdx++}`;
      runParams.push(new Date(since));
    }

    runQuery += ` ORDER BY hr.started_at DESC`;
    
    const runResult = await pool.query(runQuery, runParams);
    events = events.concat(runResult.rows);
  }

  // Get activity log entries
  if (type === 'all' || type === 'activity') {
    let actQuery = `
      SELECT 
        al.id,
        al.agent_id,
        a.name as agent_name,
        a.icon as agent_icon,
        al.actor_type,
        al.actor_id,
        al.action,
        al.entity_type,
        al.entity_id,
        al.details,
        al.created_at as started_at,
        al.run_id,
        'activity' as event_type
      FROM activity_log al
      LEFT JOIN agents a ON al.agent_id = a.id
      WHERE 1=1
    `;
    const actParams = [];
    let paramIdx = 1;

    if (agentId) {
      actQuery += ` AND al.agent_id = $${paramIdx++}`;
      actParams.push(agentId);
    }
    if (since) {
      actQuery += ` AND al.created_at >= $${paramIdx++}`;
      actParams.push(new Date(since));
    }

    actQuery += ` ORDER BY al.created_at DESC`;
    
    const actResult = await pool.query(actQuery, actParams);
    events = events.concat(actResult.rows);
  }

  // Sort all events by time
  events.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

  // Apply pagination
  const total = events.length;
  events = events.slice(offset, offset + limit);

  return { events, total, limit, offset };
}

async function getStats() {
  const [runStats, recentRuns, agentActivity] = await Promise.all([
    pool.query(`
      SELECT 
        COUNT(*) as total_runs,
        COUNT(*) FILTER (WHERE status = 'succeeded') as succeeded,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COUNT(*) FILTER (WHERE status = 'running') as running,
        COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '24 hours') as last_24h,
        COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '1 hour') as last_hour
      FROM heartbeat_runs
    `),
    pool.query(`
      SELECT 
        DATE_TRUNC('hour', started_at) as hour,
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE status = 'succeeded') as succeeded,
        COUNT(*) FILTER (WHERE status = 'failed') as failed
      FROM heartbeat_runs
      WHERE started_at > NOW() - INTERVAL '24 hours'
      GROUP BY DATE_TRUNC('hour', started_at)
      ORDER BY hour
    `),
    pool.query(`
      SELECT 
        a.id,
        a.name,
        a.icon,
        COUNT(hr.id) as run_count,
        COUNT(hr.id) FILTER (WHERE hr.status = 'succeeded') as succeeded,
        COUNT(hr.id) FILTER (WHERE hr.status = 'failed') as failed,
        MAX(hr.started_at) as last_run
      FROM agents a
      LEFT JOIN heartbeat_runs hr ON a.id = hr.agent_id AND hr.started_at > NOW() - INTERVAL '24 hours'
      GROUP BY a.id, a.name, a.icon
      ORDER BY run_count DESC
    `)
  ]);

  return {
    overview: runStats.rows[0],
    hourlyRuns: recentRuns.rows,
    agentActivity: agentActivity.rows
  };
}

const apiHandlers = {
  '/api/agents': async () => ({ agents: await getAgents(), timestamp: new Date() }),
  '/api/timeline': async (url) => {
    const params = new URL(url, 'http://localhost').searchParams;
    return { ...(await getTimeline(params)), timestamp: new Date() };
  },
  '/api/stats': async () => ({ ...(await getStats()), timestamp: new Date() }),
  '/api/health': async () => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', db: 'connected', uptime: process.uptime() };
    } catch (e) {
      return { status: 'error', db: 'disconnected', error: e.message };
    }
  }
};

// ============================================
// HTTP SERVER
// ============================================
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = req.url.split('?')[0];

  // API routes
  if (urlPath.startsWith('/api/')) {
    const handlerKey = Object.keys(apiHandlers).find(k => urlPath.startsWith(k));
    if (handlerKey) {
      try {
        const data = await apiHandlers[handlerKey](req.url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        console.error('API Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Static files
  let filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'text/plain';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(__dirname, 'index.html'), (e, c) => {
          if (e) {
            res.writeHead(500);
            res.end('Server error');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(c);
          }
        });
      } else {
        res.writeHead(500);
        res.end('Server error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🐺🔥 Activity Timeline running on http://localhost:${PORT}`);
});
