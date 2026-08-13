# Why Where's My Water AZ exists

This file has two jobs: it's a draft of the "why I built this" story for
the website itself (About page, or a section under the main tool), and
it's context for whoever builds the site, Claude Code included, so the
tone and design decisions reflect why this exists, not just what it does.

**Note on the draft below**: I've written this from what's actually been
established in prior conversations. The Peru section has bracketed
placeholders where only Sid has the real specifics, what he was doing
there, what he actually saw, who he was with. Filling those in with real
detail is what will make this land; generic phrasing about "seeing poverty"
would undercut it. Don't publish the placeholders as-is.

---

## Draft: "Why I built this"

I spent time in Peru [Sid: i was basically working in peru for one month from lima to arequipa to cuzco and working with poor and underprivileged communities in very desolate locations, building roads, houses, clearing walking paths, digging trenches, hard physical manual labor, building schools, etc], around people
living with far less than what I was used to at home. I'm not going to
pretend that trip was about water specifically, most of what I saw was
bigger than that. But it changed what I paid attention to once I got back.

I came home to Arizona and started noticing things I'd never questioned
before. One of them was water. I grew up assuming that if you live in
Arizona, you turn on the tap and water comes out, and that's just how it
works. It turns out that's not true for everyone here. In Rio Verde
Foothills, just outside Scottsdale, residents got cut off from hauled
water in January 2023 because of a dispute with the city, and some of them
still don't have a reliable, affordable way to get water. That's not a
problem happening somewhere far away. It's less than an hour from where I
live.

Around the same time, I heard about Emilio Saenz, another Arizona high
schooler, who'd noticed something similar in a completely different area:
Arizona's Department of Education didn't maintain a public list of which
schools offered bilingual or dual-language programs, even though families
needed exactly that information to make decisions for their kids. So he
built Navegante, a free directory that didn't exist before he made it, and
local news picked it up.

What stuck with me wasn't just that he built something. It's that the
information he needed was already out there, technically public, just
scattered, unmaintained, or sitting in a database nobody outside a state
agency ever opens. Nobody had done the unglamorous work of pulling it
together into something an actual person could use.

Water in Arizona has the same problem, and it's worse. The data on who's
allowed to drill a well, whether a subdivision has a legally certified
100-year water supply, which areas are actually regulated versus which
aren't, it all exists. It's split across five or six different government
systems that don't talk to each other, in formats built for GIS analysts,
not homeowners. And on top of that, there's an even more basic gap: if
your water situation is genuinely precarious, there's no single place that
tells you where to actually go get water nearby. People in Rio Verde
Foothills found water haulers the same way people find anything when the
system doesn't help them: word of mouth, Facebook groups, a community
website someone built out of necessity.

Where's My Water AZ starts with that second problem. Type in your address,
and the first thing you get is real, physical places to get water nearby.
Alongside that, who your official water provider is and whether their
water is actually safe. And underneath both of those, the regulatory
picture, whether you're in a protected area, how many wells are near you,
whether there's a certified water supply for your subdivision, pulled
directly from ADWR's public data.

None of this is about pointing fingers at any one cause of Arizona's water
strain, agriculture, growth, data centers, drought, it's all part of it,
and reasonable people disagree about how much each one matters. This
project isn't trying to settle that argument. It's trying to make sure
that whatever is true about your water, you can actually find it out,
instead of learning it the way Rio Verde Foothills did: after the water
was already gone.

---

## Notes for whoever builds the site (including Claude Code)

- Keep the Peru framing understated. The point isn't "I saw suffering, now
  I care," it's "that experience changed what I noticed when I got home."
  Avoid language that reads as using someone else's hardship as a personal
  growth prop.
- The Emilio/Navegante mention is real and should stay factual: he's a
  real person with a real project, don't embellish beyond what's in the
  roadmap's Section 1 and Section 4.
- The site's actual design should not visually copy Navegante, this is
  already a firm decision (see wmwRoadmap.md, Section 5).
- This story works best short, on the site itself. Full version above is
  meant to be trimmed, not all of it needs to appear verbatim, adapt
  length to wherever it's placed (About section, footer note, or a
  standalone page).
