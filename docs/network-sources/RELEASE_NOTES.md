# Readest Remote Experimental 0.12.12-x1

This experimental channel introduces a native content plugin API and optional Legado/Venera
compatibility adapters. It installs separately from Readest Remote and uses a separate
profile and `readest-remote-x` URL scheme.

The content workflow includes source instances and origin grants, search, chapter directories,
reading, library collection and chapter downloads. Plugin API 2 dictionary/library packages
remain supported; native content plugins use API 3 without either compatibility engine.

See COMPATIBILITY.md for the specific validated sources and unsupported operations. Web
clients remain subject to browser networking restrictions. Online-source cloud sync and
automatic source switching are not included. The x1 release candidate must pass all stated
compatibility and platform gates before publication.
