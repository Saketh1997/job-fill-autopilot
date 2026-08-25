#!/usr/bin/env python3

import yaml
import json
from datetime import datetime, timedelta

# Load portals.yml
with open('portals.yml', 'r') as f:
    config = yaml.safe_load(f)

# Extract search queries
search_queries = config['search_queries']
posted_within_hours = config['scan_options']['posted_within_hours']

# Calculate date threshold
threshold_date = datetime.now() - timedelta(hours=posted_within_hours)
threshold_date_str = threshold_date.strftime('%Y-%m-%d')

# Prepare queries
queries_to_run = []
for query in search_queries:
    if query.get('enabled', False):
        search_query = query['query']
        if 'after:' not in search_query:
            search_query = f'{search_query} after:{threshold_date_str}'
        queries_to_run.append({
            'name': query['name'],
            'query': search_query
        })

print(json.dumps(queries_to_run, indent=2))