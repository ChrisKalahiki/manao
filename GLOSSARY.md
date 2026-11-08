# Manaʻo

A personal hub that gathers what is on the user's plate (tasks, appointments, running agents, health signals) from many sources into one view for people and agents.

## Language

### Sources

**Source**:
One place the hub learns from, such as the Herdr app, an Obsidian vault or a Google calendar.
_Avoid_: integration, provider, feed

**Adapter**:
The part of the hub that reads one Source and reports what it finds as Items, Events and Health.
_Avoid_: connector, plugin, driver

**Health**:
Whether the hub can currently reach a Source, and when it last could.
_Avoid_: status (Status belongs to Items)

**Healthy**:
A Source whose latest Health report succeeded and is recent. An old success counts as unhealthy, so a stopped hub makes every Source unhealthy.
_Avoid_: up, online, connected

### What the hub knows

**Item**:
One thing that currently is: a task, an appointment, an agent. Only its present state is kept.
_Avoid_: record, entry, entity

**Status**:
An Item's current state, in its Source's own vocabulary.

**Attention**:
A flag an Adapter raises on an Item that needs the user now, by that Source's own rules.
_Avoid_: alert, urgent, priority

**Stale**:
Describes an Item whose Source is not currently healthy: shown as last known, not as current.
_Avoid_: old, cached, outdated

**Event**:
Something that happened, such as an agent finishing work. Events are history; Items are the present.
_Avoid_: change, notification, log entry

**Agent**:
A program running in one of the Herdr app's terminals that reports its own status, such as Claude Code or Codex. A terminal running only a shell is not one. One Agent is one Item, keyed by its terminal.
_Avoid_: pane, session, worker

**Appointment**:
A time-bound entry from one of the user's calendars, timed or all-day, that they have not declined.
_Avoid_: calendar event, event, meeting

**Todo**:
An action the user still means to take, written as a checkbox in the current Weekly Note's to-do section.
_Avoid_: task, action item

**Todo Group**:
A plain bullet in a Weekly Note's to-do section that gathers Todos for one project or kind of work; groups can nest.
_Avoid_: category, project, heading

**Weekly Note**:
The vault note for one week, holding that week's updates and Todos.
_Avoid_: weekly update, journal

**Agenda**:
What is on the user's plate Today: the Items that need their Attention, Today's Appointments, their open Todos, and which Sources it may be missing because they are Stale. People and agents see the same Agenda.
_Avoid_: today page, plate, summary, overview

**Metric**:
A kind of daily value the hub tracks about the user, such as steps, sleep duration, resting heart rate or active zone minutes.
_Avoid_: measure, signal, data type

**Measurement**:
One value of one Metric for one day, such as steps on 2026-10-19. A day with no data has no Measurement, which is not the same as a Measurement of zero. A night's sleep belongs to the day the user woke up. Unlike Items, past Measurements are kept.
_Avoid_: health data, stat, vital

### Time

**Today**:
The current calendar day in the hub's one configured time zone, shared by every consumer.
_Avoid_: local day, client day
