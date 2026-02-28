import { render, screen } from '@testing-library/react';
import App from './App';

test('renders navigation heading', () => {
  render(<App />);
  const heading = screen.getByText(/navigation/i);
  expect(heading).toBeInTheDocument();
});
