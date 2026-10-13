"""Deterministic synthetic shop data for the examples: `python3 generate.py` rewrites
orders.csv and customers.csv byte for byte (seeded PRNG, no wall clock)."""

import csv
import datetime as dt
import math
import random

rng = random.Random(20261008)

REGIONS = {
    "EU": ["DE", "FR", "GB", "ES", "IT", "NL", "PL"],
    "North America": ["US", "CA", "MX"],
    "APAC": ["JP", "AU", "IN", "SG", "KR"],
    "LATAM": ["BR", "AR", "CL", "CO"],
}
REGION_WEIGHT = {"EU": 0.34, "North America": 0.38, "APAC": 0.18, "LATAM": 0.10}
CHANNELS = {"web": 0.42, "app": 0.31, "retail": 0.17, "partner": 0.10}
CATEGORIES = {  # base unit price, margin, return probability
    "Electronics": (240.0, 0.18, 0.06),
    "Home": (85.0, 0.32, 0.04),
    "Fashion": (60.0, 0.45, 0.14),
    "Beauty": (35.0, 0.52, 0.05),
    "Sports": (70.0, 0.35, 0.05),
    "Toys": (30.0, 0.40, 0.03),
    "Books": (18.0, 0.28, 0.02),
    "Grocery": (25.0, 0.15, 0.01),
}


def pick(weights):
    r = rng.random() * sum(weights.values())
    for key, w in weights.items():
        r -= w
        if r <= 0:
            return key
    return key


START = dt.date(2024, 1, 1)
DAYS = (dt.date(2025, 12, 31) - START).days + 1

customers = []
for i in range(1, 1501):
    region = pick(REGION_WEIGHT)
    customers.append({
        "customer_id": i,
        "signup_date": (START - dt.timedelta(days=120) + dt.timedelta(days=rng.randrange(DAYS))).isoformat(),
        "segment": "business" if rng.random() < 0.2 else "consumer",
        "region": region,
        "country": rng.choice(REGIONS[region]),
    })

orders = []
order_id = 0
for day in range(DAYS):
    date = START + dt.timedelta(days=day)
    trend = 1 + day / DAYS * 0.6
    season = 1 + 0.35 * math.exp(-((date.month - 11.6) ** 2) / 1.5) + 0.08 * (date.weekday() >= 5)
    for _ in range(int(rng.gauss(7 * trend * season, 2)) or 1):
        c = rng.choice(customers)
        if c["signup_date"] > date.isoformat():
            continue
        order_id += 1
        category = rng.choice(list(CATEGORIES))
        price, margin, p_return = CATEGORIES[category]
        quantity = 1 + int(rng.expovariate(1.2)) + (3 if c["segment"] == "business" else 0)
        revenue = round(price * quantity * rng.uniform(0.7, 1.3) * (1.1 if c["region"] == "North America" else 1.0), 2)
        orders.append({
            "order_id": order_id,
            "order_date": date.isoformat(),
            "customer_id": c["customer_id"],
            "region": c["region"],
            "country": c["country"],
            "channel": pick(CHANNELS),
            "category": category,
            "quantity": quantity,
            "revenue": revenue,
            "cost": round(revenue * (1 - margin) * rng.uniform(0.9, 1.1), 2),
            "returned": 1 if rng.random() < p_return else 0,
        })

for name, rows in (("customers.csv", customers), ("orders.csv", orders)):
    with open(name, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    print(name, len(rows))
