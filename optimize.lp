#program base.
client(c1;c2;c3;c4;c5;).
switch(s1;).

host(X) :- client(X).
host(X) :- switch(X).

% The physical layout resolves to paths with different bandwidth latency characteristics. The rest
% of the domain ignores these facts right now.
% FromHost, ToHost, Capacity, Latency
link(
    c1, s1, 8, 15;
    s1, c1, 20, 15;
    c2, s1, 8, 15;
    s1, c2, 20, 15;
    c3, s1, 8, 15;
    s1, c3, 20, 15;
    c4, s1, 8, 15;
    s1, c4, 20, 15;
    c5, s1, 8, 15;
    s1, c5, 20, 15;
).

% Base case: direct link between hosts
path(H1, H2, Latency, Hops) :- link(H1, H2, _, Latency), Hops=1.
% Recursive case
path(H1, H3, Latency, Hops) :- Hops<10, Hops=Hops1 + 1, Latency=Latency1 + Latency2, path(H1, H2, Latency1, Hops1), link(H2, H3, _, Latency2).

%shortest_path(H1, H2, Latency, Hops) :- #min{path(H1, H2, Latency, Hops)}.


% Generate (all possible overlay configurations)
% Assumes origin has data to broadcast to a subset of other clients
{
    forward(Origin, From, To) : client(From), client(To), client(Origin), From != To
}.

% Origin can forward from self to another client
% HAX: Assume fixed latency. It should come from the latency of the shortest path in the physical network
talks(O, A, Latency) :- Latency=15, forward(O, O, A), client(A), client(O), O != A.
% If a client forwards something that it's been forwarded, it extends the talks relationship, but with more latency.
% There can be forwarding cycles so we'll only define this predicate up to a certain latency
talks(O, B, Latency) :- Latency=L + 15, talks(O, A, L), forward(O, A, B), client(A), client(B), client(O), A != B, Latency <= 120.

% Convenience; relationship without attributes
talks(O, B) :- talks(O, B, _).

% HAX: Assume unit bandwidth for now
capacity_used(H1, Total) :- Total=#count{forward(H1, X, Y): forward(H1, X, Y)}, client(H1).

% Note: Aggregate is set of all (ClientTotal, C) pairs, then the sum is applied and takes the first value as the weight
total_capacity_used(Total) :- Total=#sum{ClientTotal, C: capacity_used(C,ClientTotal), client(C)}.

max_capacity_used(Max) :- Max=#max{U: capacity_used(C, U), client(C)}.

unfairness(H1, Unfairness) :- Unfairness=Max-Used, max_capacity_used(Max), capacity_used(H1, Used), client(H1).

%%%%%%%%%%%%%%%%%%%%%
% OPTIMIZATION
%%%%%%%%%%%%%%%%%%%%%

% Lexicographic multi-criteria optimization (greatest weight to least)

% Use least amount of bandwidth, globally
#minimize{U @ 3: total_capacity_used(U)}.

% Make sure no one has a high max. Not necessary, but extra criteria help in some hard problems.
#minimize{U @ 2: max_capacity_used(U)}.

% Distribute burden
#minimize{U @ 1: unfairness(C, U), client(C)}.

%%%%%%%%%%%%%%%%%%%%%
% INSTANCES
%%%%%%%%%%%%%%%%%%%%%

% Just one connection
%:- not talks(c1, c2).

% One to All

%:- not talks(c1, (c2;c3;c4;c5)).

% All to all
:- not talks(A, B), client(A), client(B), A!=B.

#show forward/3.
#show total_capacity_used/1.