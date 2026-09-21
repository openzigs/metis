# Subscription Billing Requirements

> Original synthetic document authored for the METIS Domain Eval golden corpus (CC0-1.0).

## Overview

Business requirements for the recurring subscription billing engine.

## Requirements

- Billing is critical and must prorate mid-cycle plan changes to the day.
- The engine must retry failed payments on a configurable dunning schedule.
- Invoices should include jurisdiction-aware tax calculation for each line item.
- Invoices older than seven years may be archived to cold storage.
