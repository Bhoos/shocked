import { createScope } from 'shocked';

const ROOMS = {
  python: [],
  java: [],
  javascript: [],
  ruby: [],
  php: [],
};


const getMembers = (room) => {
  const members = ROOMS[room];
  if (!members) {
    throw new Error(`Unknown room ${room}`);
  }
  return members;
};

const chat = createScope('chat', (session) => {
  console.log('Scoped session for chat');

  // Provide all the rooms available
  session.dispatch({
    type: 'ROOMS',
    payload: Object.keys(ROOMS),
  });
});

function leave() {
  const { session } = this;
  const user = session.get('user');
  const room = session.get('room');

  session.channel(room).dispatch({
    type: 'REMOVE_MEMBER',
    payload: user.id,
  });

  // Remove from the list
  ROOMS[room] = ROOMS[room].filter(u => u.id !== user.id);

  // Unsubscribe from the room specific channel
  session.unsubscribe(room);
}

chat(leave);

function join(room) {
  const { session } = this;

  const user = session.get('user');
  console.log(`JOIN ${room} ${user.name}/${user.id}`);

  // Validate the room first
  const members = getMembers(room);

  // Let everyone on the room know that a new user has joined
  session.channel(room).dispatch({
    type: 'ADD_MEMBER',
    payload: user,
  });

  // Subscribe to the given room
  session.subscribe(room);

  // Add the user on the room
  ROOMS[room].push(user);
  session.set('room', room);

  // Make sure the user leaves if the connection is closed
  session.addCloseListener(() => {
    leave.call({ session });
  });

  // Dispatch the room information to the joining member
  session.dispatch({
    type: 'MEMBERS',
    payload: {
      room,
      members,
    },
  });
}

chat(join);

function send(message) {
  const { session } = this;

  const user = session.get('user');
  const room = session.get('room');

  session.channel(room).dispatch({
    type: 'MESSAGE',
    payload: {
      from: user.id,
      message,
    },
  });
}

chat(send);

